# Implementation Roadmap

The spec ([`../specs/2026-10-06-installer-design.md`](../specs/2026-10-06-installer-design.md))
covers several subsystems. It is delivered as **ten plans**, each producing
working, tested software on its own. Plans are written one at a time: a
plan is detailed only after the previous one has shipped, because later
plans build on the earlier plans' real signatures.

Language: TypeScript on Node ≥ 22 (D44).

| # | Plan | Deliverable | Depends on | Spec sections | Open items it resolves | Status |
|---|---|---|---|---|---|---|
| 1 | **Engine core** | `installer start / next / submit / verify / resume / report` driven by a scripted operator against a fixture solution; atomic resumable state; hash-chained audit; kill-between-steps and idempotency tests | — | §6.3–6.6, §11.8 (audit chain), §15.1 (engine tests), §15.2 (scripted operator) | — | [Written](2026-10-06-01-engine-core.md) |
| 2 | **Runtime conformance + brain phase** | Runtime profiles, `installer probe` (C1–C6), Claude Code profile certified, `INSTALL.md` bootstrap, `agent_action` intents, Skills Wiki MCP registration + verify, manual combo activation step, `skillswiki:` solution refs, MODE phase (deployment mode + roles) | 1 | §5, §6.1–6.2, §7, §13 | O1 (Codex live test), O6 (`mcp add` syntax), O10 | Not started |
| 3 | **Secrets + connector framework** | Local browser page for `secret`/`oauth`, OS keychain storage, connector definition loader, pinned + checksummed connector packages, `installer disconnect` | 1, 2 | §8, §14.2 (secrets, supply chain) | O3 (headless OAuth redirect) | Not started |
| 4 | **Local MCP server + approvals** | Local MCP server, `installer tool` CLI fallback, approval items, action-hash tokens, level derivation, compiled floor, decisions (approve / edit / reject / expire), roles | 1–3 | §7.4, §11.1–11.6, §11.9 | — | Not started |
| 5 | **Data layer** | Data contract, phase-3 mapping, `records.*` tools, field tags, spreadsheet connector (Google / Microsoft), default sheet creation, import with change preview, optimistic concurrency | 3, 4 | §9 | — | Not started |
| 6 | **Gateway + channels** | Always-on gateway, channel connector interface, Telegram + email connectors, inbound envelope, injection marking, sender identity via `invite`, reply codes, opt-out, consent policy | 3, 4, 5 | §12, §11.9 | O4 (tunnels, webhook channels later) | Not started |
| 7 | **Workflow runner** | Workflow files, `tool` / `judge` / `approve` steps, judge invocation via profile or direct-model fallback, OS-scheduler triggers, event triggers, run log, idempotency keys, missed-run rule, host-back-online notice, twice-daily report, escalation | 2, 4, 5, 6 | §10.1–10.7, §10.9, §10.3 (D38–D40) | O14 (per-OS scheduler behaviour) | Not started |
| 8 | **Workflow lifecycle** | Phases 5–7 (workflows, dry run, activate), sandbox mode + recording sink, agentic mode, hardening proposals + replay gate, earned autonomy, urgent events, learning loop | 7 | §10.8, §10.10, §11.6–11.7, §15.5 | O12 (thresholds, first pass) | Not started |
| 9 | **Operations + security hardening** | `doctor`, host readiness (Layer 1), pause / unpause, uninstall, support bundle, pack pinning + shadow upgrade, data-flow summary, retention | 1–8 | §5.1, §14, §16 | — | Not started |
| 10 | **CI matrix + certification** | CI for engine + scripted operator, nightly real-agent matrix, connector contract nightlies, universal injection suite, Codex certification | 1–9 | §15 | O2 (vendor terms), O5 (other profiles), O7 (CI budget cap) | Not started |

O8 (product name), O11 (unattended hosted evals) and O15 (combo activation
by API key) are handled when the plan that touches them is written.
