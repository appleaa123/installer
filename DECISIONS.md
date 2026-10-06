# Installer — Design Decision Log

Brainstorming record for a generic, agent-driven installer that deploys
Skills Wiki solutions (combos + workflows + connectors) onto a client's own
AI agent. First target: a real Ontario realtor team (9 people) doing
property management for investor-owners. Must stay industry-agnostic.

- Started: 2026-10-06
- Process: superpowers brainstorming, **architectural path** (sectioned
  design → written spec → implementation plan). No code yet.
- Status: Design complete (D1–D34). Spec written: `docs/superpowers/specs/2026-10-06-installer-design.md` — awaiting user review, then writing-plans.

---

## 1. Context

### 1.1 The realtor's problem statements (from the real client)
1. Proactive lease & rent optimization (flag ahead, market review, owner
   advice, form, e-signature).
2. Maintenance routing (tenant video, appliance DB, route to trade worker,
   emergencies).
3. Unified CRM: Renter / Property / Owner profiles, timestamped notes,
   birthdays, life context, cadence (3–4 mo: email → text → phone → in
   person), escalation (team → owner approval).
4. Conversational DB management for a 9-person team, Excel upload, AI gives
   the "why", human-in-the-loop before writes.
5. Compliance & finance: missed rent → N4, N12 notices, cheque timelines,
   tax-ready expense records to owners, rent receipts.

### 1.2 Existing assets
- `skills_directory/property-management-skills` — 6 skills present
  (property-db, maintenance-triage, client-care-route, rent-adjustment,
  ltb-forms, manager-persona). README also lists `skill-improve`,
  `schema.md`, `log_feedback.py`, bundled LTB PDFs — **these do not exist**.
- `skills_directory/maintenance-triage-skill` (severity + SLA, `sla.py`,
  golden evals).
- `skills_directory/real-estate-tenancy-assistant-skill` (issue vs tenancy
  FAQ router, golden evals).
- `skills_directory/property-staging-skill` (virtual staging).
- Skills Wiki combo **Real Estate Property Operations Assistant**
  (`real-estate-property-operations-assistant`) + realtor content packs
  (`realtor_listing_copy`, `realtor_followup_sequences`,
  `realtor_market_brief`).

### 1.3 Gaps found in the realtor skills (not yet fixed)
- No **Owner** entity; no **Ledger** / payments / expenses (blocks automated
  N4 detection and owner statements).
- Rent flag at 3 months is too late: Ontario N1 needs 90 days' written
  notice → flag ~150 days out.
- N9 is a **tenant's** notice — record it, don't generate it.
- CRM fields like family/marital status are protected grounds under the
  Ontario Human Rights Code — allowed for relationship touches, **must be
  excluded** from rent / notice decisions (add to `hitl-rules.md`).
- Two overlapping maintenance-triage skills (suite + standalone) — merge.
- Realtor content packs cite the US Fair Housing Act — need Ontario
  localization (Human Rights Code, RECO advertising rules).

### 1.4 Product framing (from discussion)
Investor-client lifecycle connects the two combos:
`BUY (CMA) → RENT OUT (staging, listing copy, follow-ups) → MANAGE (triage,
LTB forms, care route) → REVIEW (rent review + owner report) → SELL / BUY
NEXT (CMA)`. Strongest cross-combo artifact: quarterly owner portfolio
review.

Autonomy ladder (applies to any industry):

| Level | Scope | Gate |
|---|---|---|
| L0 | Read / think | Autonomous |
| L1 | Internal team messages (digests) | Autonomous |
| L2 | Client-facing messages | Draft → one-tap approve |
| L3 | Legal / financial | Approve + human sends/serves |

---

## 2. Verified facts (with source)

### 2.1 Runtimes / vendors (web, 2026)
- Anthropic: since **2026-04-04**, Pro/Max subscription limits cannot power
  third-party harnesses (OpenClaw etc.). Subscription OAuth is for Claude
  Code and Claude.ai only. Third-party runtimes need API keys.
- Claude Code **Channels** (research preview): Telegram, Discord, iMessage;
  a channel is an MCP server (custom channels possible); requires claude.ai
  login; events only arrive while a session is open.
- Claude Code cloud routines run in the cloud → **cannot reach local
  secrets / local MCP**.
- Antigravity: `/schedule` cron, `agy` headless; Additional Terms clause 6
  treats third-party access as a breach; quota windows stop tasks mid-run.
- Codex: usage rides ChatGPT plan, 5-hour + weekly windows.
- OpenClaw: 20+ channels incl. WhatsApp (via WhatsApp Web) and WeChat,
  Markdown skills, cron. Hermes Agent: messaging gateway, cron with delivery,
  memory, self-written skills.
- Channel constraints: WhatsApp → use WhatsApp Business Platform (Cloud API)
  for client traffic (Web bridges risk bans). WeChat → WeCom / Official
  Account (personal automation risks bans). SMS → CASL consent +
  unsubscribe.

### 2.2 Skills Wiki source (`/Users/allenliu/Desktop/ML-Project/skills_wiki`)
- MCP server is **hosted, multi-tenant** (shared Railway); per-client URL
  via `gatewayUrl(clientId, "mcp")` (`dashboard/app/api/onboard/route.ts`).
- **Connections** store encrypted client credentials server-side
  (`client_service_credentials`, `core/credentials.py`); built-in services
  + custom `{url, token}`.
- Combo export: `/api/combos/[id]/export` → portable Agent Skills bundle
  (Pro-gated). `/api/agent/bootstrap` serves a spec to `skills-wiki-agent`.
- `agent/` = **`skills-wiki-agent`**, provider-agnostic TS CLI runtime
  (orchestrator, sandbox, permissions ask|allow|deny, MCP tools,
  Anthropic/OpenAI/Gemini clients; uses API keys).
- Hosted evals (`main.py:682–737`): behind a master flag; need
  `skills_library/<pack>/evals/tasks.jsonl` + `rubric.json`; **graded by
  the calling agent (self-grading)**. `property_management` and
  `property_staging` have suites; **`maintenance_triage` and
  `real_estate_tenancy_assistant` do not**.
- `combo_gate` (`core/decision/combo_gate.py`): advice only; needs
  `JEV_COMBO_CLIENTS` allowlist **and** a `<workflow>` block in the combo;
  caps 50/client/day, 500/day. The realtor ops combo has **no `<workflow>`
  block**.
- `loop_engineering` tools mount only when the combo has Expert Loop on;
  realtor combo `has_loop: false`. **Not** suitable as installer state.
- Pack versioning exists: `skill_pack_meta.commit_sha`.
- MARKETING files: **ignore** (user: marketing material, not accurate).

---

## 3. Decisions

| ID | Decision | Notes |
|---|---|---|
| D1 | **Split brain and body.** Skills Wiki = hosted brain (skills, combos, rules, evals, learnings). Installer + local pack = body on the client's side (runtime config, connectors, workflows, schedules, approvals, audit). | Different lifecycle, trust boundary, failure domain. |
| D2 | **Client owns everything.** Client chooses the agent (Claude Code, Codex, OpenClaw, Hermes, …) and pays for subscription/tokens. Allen only sets up and delivers. No step may need Allen's account or keys. | |
| D3 | **Deterministic installer CLI + agent as operator** (Approach B). Rejected: Markdown-only runbook (not testable/resumable); prebuilt appliance (locks runtime; maybe later as a delivery option). | Same principle as `sla.py`: script the mechanics. |
| D4 | **Installer registers Skills Wiki itself** as one phase (asks once for the key). Not a separate user request. | |
| D5 | **General engine.** Layers: Engine (generic) → Connector catalog (reusable) → Recipe (per industry, optional). New industry = new recipe/connectors, **never** an `if industry` branch. | |
| D6 | **Recipe vs instance config.** Combo = how to think (Skills Wiki). Recipe = suggested defaults, stored as a **file resource in a Skills Wiki pack** (fetched via existing `get_skill_resource`) → **no Skills Wiki code change to start**. Instance config (this client's schedules, channels, approvals, workflows) = **local**, written interactively. | Dedicated manifest feature in Skills Wiki only when fleet management is needed (~5–10 installs, or first push-upgrade). |
| D7 | **Host agent is the adapter.** Installer states intent → agent implements natively → installer verifies. Optional per-runtime hint files. | Removes most per-runtime adapter code. |
| D8 | **Operational secrets stay local** (OS keychain / client runtime). Only services that belong in Skills Wiki stay in Skills Wiki Connections. | User decision. |
| D9 | **Deployment mode chosen in onboarding** via 3 questions: Q1 shared work? Q2 must run with laptops closed? Q3 who approves what? → **Personal** (each member's own business AI seat) / **Team host** (client-owned Mac mini or small server, team uses a shared channel, no laptop installs) / **Hybrid** (likely most common). | Permissions are separate from shared work (roles still apply on a host). |
| D10 | **Workflows run on a small local typed-step runner** (not agent-does-everything, not n8n by default). | n8n backend may be an option later. |
| D11 | **Workflow lifecycle:** describe in plain words → dry run (outbound OFF, human confirms) → agentic live runs (all tool calls recorded) → runner **proposes** hardening repeated plumbing into `tool` steps → human approves → **replay on past inputs must match** → new version live. Tokens then go only to `judge` steps. | |
| D12 | **Schedules belong to the runner** via the OS scheduler (launchd / systemd / cron), not the agent's scheduler. Agent is invoked only for `judge` steps. | Survives switching runtimes. |
| D13 | **Connectors are MCP servers; the runner is an MCP client.** One tool surface shared by chat and workflows. | |
| D14 | **Step types:** `tool` (deterministic, may act within approval level), `judge` (host agent headless, skill + output schema, **no write tools**), `approve` (enqueue, pause, resume). Modifiers: `foreach`, `when`. Rule: **judges think, tools act, humans approve.** | |
| D15 | **Judge = pure by default + scoped read-only `context_tools`** (option c). Runner **binds parameters** (e.g. `tenant_id = this item`); call budget (`max_tool_calls`); tool calls + results recorded so replay uses recorded responses. Hardening promotes frequent context calls into prior `tool` steps. Pure vs context-tools decided per workflow by evals. | |
| D16 | **Runner validates judge JSON itself** regardless of runtime support. Failure → retry once with error → `needs_human`. | |
| D17 | **Run log:** per-run folder + append-only `audit.jsonl` (input fingerprint, output, duration, status, usage); **idempotency key** per trigger (e.g. `workflow:date`); resumable after approve pause / crash / quota stop. | |
| D18 | **Escalation has three distinct causes:** uncertainty (schema fail / low confidence), policy (L2/L3 always need approval even when confident), drift (hardened step fails → fall back to agentic for that run + flag). | |
| D19 | **Learning loop:** human overrides of judgments → Skills Wiki `learning_record`; `doctor` re-runs evals after skill updates. | |
| D20 | **One CLI package, subcommands:** `install` / `start` / `next` / `submit` / `resume` / `report` / `run` / `harden` / `doctor` / `invite`. | Name TBD. |
| D21 | **Section 3 setup conversation approved** as written in §4 (bootstrap `INSTALL.md`, phases 0–8, JSON step protocol, secrets bypass the agent, connector definitions, resumable state, report, `invite`). | 2026-10-06 |
| D22 | **Secret / OAuth entry = local browser page served by the CLI (localhost).** Headless-server fallback: CLI prints a one-time link to open from a phone/laptop (redirect mechanics still to verify). Masked terminal prompt rejected for non-technical users. | 2026-10-06 |
| D23 | **Section 4 approved:** approvals enforced **at the tool layer** (write/outbound tools refuse without an approval token bound to the exact action hash); one queue for workflows **and** chat-originated writes; item fields incl. mandatory `why`; decisions Approve / Edit (diff → learning) / Reject / Expire (remind → escalate role); L3 approval never sends — produces document + serve checklist, human marks *served*; approval surface = team channel buttons + universal reply codes (`A42`/`E42`/`R42`); approver identity bound via `invite` + role check; append-only hash-chained `audit.jsonl`; queue in local SQLite. | 2026-10-06 |
| D24 | **Forced human approval floor (user rule):** legal, financial, and anything the model must not self-approve **always** need a human, however confident the model is. Floor categories: legal notices/filings; money (rent, payments, deposits, expenses, invoices, refunds); contracts / signatures / lease terms; irreversible actions (deletes, bulk overwrites); disclosure/export of personal data to third parties; changes to approval policy, roles, permissions, connectors; any decision using protected-ground data. **Level is assigned deterministically by tool + args (connector `risk` metadata), never chosen by the model.** Client config may add categories but **cannot remove the floor**. Never eligible for earned autonomy. | 2026-10-06 |
| D25 | **Earned autonomy (4.6) included:** runner tracks approval history per action type; after a streak of unedited approvals it **proposes** L2 → auto; human decides; logged; any later edit/reject reverts automatically; **never for L3 / D24 floor**. | 2026-10-06 |
| D26 | **Urgent events (general, any industry), resolves §5.1.** "Operator" = the client's **top decision maker role** (e.g. team manager who assigns work), never the external worker/vendor. (1) Urgent internal alert **skips the queue**: notify the decision-maker role immediately, escalating channel until acknowledged (L1). (2) The external action (dispatching a vendor/worker, spending money) stays a **human approval on an urgent fast path** (top of queue, one tap, escalates within minutes). (3) **Any external safety/instruction message also requires human input** — no pre-approved templates; the model may draft, a human decides. Which events count as urgent is defined by the recipe/connector, not hard-coded. | 2026-10-06 |
| D27 | **Generality guardrail (user, repeated):** the installer is for the **general public and any business** (individuals via Personal mode, teams via Team host/Hybrid). Every engine-level concept — phases, step protocol, data contract, tags, tools, channels, approvals — must be industry-neutral; industry terms appear only in recipes and examples. | 2026-10-06 |
| D28 | **Section 5 data layer approved:** meet data where it lives (client's system of record via data connectors); four data kinds with fixed homes — business records (client system / local SQLite fallback), operational state (always local SQLite), audit (local hash-chained JSONL), secrets (OS keychain); **recipes declare a data contract** (entities, keys, `match_keys`, fields, relations, tags); tags drive behaviour: `financial` → floor approval, `protected_ground` → never input to decision `judge` steps and blocked from export, `personal` → redacted off-host + listed in privacy summary; phase-3 mapping (ask → sample headers/rows as data → agent proposes field→column map → human confirms → gaps via approved new column or local extension table); one generic tool surface `records.find/get/match/propose_update/apply_update/import` (import = change preview → approval; bulk overwrite = floor); read-through with short cache, no full mirror; optimistic concurrency via expected value inside the action hash. | 2026-10-06 |
| D29 | **Default store when the client has no system yet = a spreadsheet the installer creates in the client's own Google or Microsoft account.** Rejected as default: local SQLite chat-only (invisible → adoption risk), hosted Postgres (too technical); both remain selectable. | 2026-10-06 |
| D30 | **Section 6 approved. Inbound = the engine's own gateway, always (6.5 option a).** A small always-on daemon on the host owns every channel; conversations call the host agent headless and resume the session. Same identity, roles, approvals, injection scan, opt-out and audit on every runtime; runtime switch changes nothing. Native runtime channels not used. Section 6 contents as presented: two audiences (internal/external), channel connectors with common interface + declared capabilities (buttons, attachments, reply_window, inbound mode) + risk (official_api); standard inbound envelope, untrusted marking, sender identification via `records.match`; **event triggers** for workflows (extends D12); opt-out auto-honoured + logged; consent policy per recipe/jurisdiction; default internal channel = what they already use, else Telegram; webhook channels need a tunnel (verify). | 2026-10-06 |
| D31 | **Section 7 approved (testing & evaluation):** 7.1 engine tests without a model (idempotency, kill-between-steps resume, approval-token tamper, D24 floor incl. via earned autonomy/config, tag enforcement, audit-chain tamper, concurrency); 7.2 runtime matrix = scripted fake operator on every commit + nightly real agents in clean VMs/containers with mock connectors (completion rate, extra interventions, time to first value, failures by phase, tokens); 7.3 connector contract tests (recorded fixtures + nightly live sandbox accounts); 7.4 workflow golden cases (deterministic checks first), Skills Wiki hosted evals where suites exist, **cross-model grading in CI** for subjective checks, replay tests, universal injection suite; 7.5 client-side sandbox mode (outbound → recording sink, admin-only recipients) + daily `doctor` (health, expiring logins, audit chain, re-eval on pack version change, drift alerts). | 2026-10-06 |
| D32 | **Runtime conformance (support any agent without owning it).** Minimum agent contract C1 read URL/MD · C2 shell + JSON (**hard requirement**) · C3 relay to human · C4 headless prompt→text · C5 headless resume · C6 MCP client. Fallbacks: C4 missing → **direct-model fallback** (runner calls model API with the client's own key; reuse `skills-wiki-agent` LLM clients); C5 missing → engine keeps/replays conversation history; C6 missing → **every MCP tool also exposed as a CLI subcommand** (`installer tool …`), same approval-token enforcement. **Runtime profiles are data** (YAML: headless cmd, resume, schema, tools-off flag, MCP config, hints). Phase-0 **`installer probe`** tests C1–C6 on the client's real agent → capability map + support level in the report. Support tiers: **Certified** (nightly CI, guaranteed) · **Compatible** (profile + probe passes) · **Unknown** (probe + fallbacks). Desktop-only agents (e.g. WorkBuddy) stay Compatible + manual pre-release check. Vendor ToS per runtime must be checked before certifying (Antigravity clause 6 → default to direct-model fallback for judge steps). | 2026-10-06 |
| D33 | **CI test budget funded by Allen** (test accounts/keys only; clients still pay their own usage, consistent with D2). Certify **Claude Code first, then Codex**; monthly spend cap (amount TBD); small models + mock connectors. | 2026-10-06 |
| D34 | **Section 8 security model** as presented: threat model (outside contacts, supply chain, poisoned brain, insider, host, model error) mapped to controls; NEW: connector checksums + signed installer updates; **skill text can never grant capabilities** (permissions only from local config, tags, floor); **new Skills Wiki pack versions run in sandbox shadow until evals pass, then decision maker approves the switch**; `learning_record` bodies redacted of personal fields; `installer disconnect <connector>` revokes + deletes credentials; engine runs as dedicated OS user, files confined, gateway localhost-only, tunnels expose only webhook paths with signature verification, preflight checks disk encryption; data-flow summary in report + configurable retention; **kill switch** `/pause` (decision-maker role, from team channel) or `installer pause` stops all outbound + schedules, inbound still logged, `/resume`; `installer uninstall` removes schedules/MCP/secrets, exports audit, leaves business records. **8.4 Allen's access = diagnostic bundles only:** client runs `installer support bundle` → redacted package (state, report, errors, config without secrets or personal data) sent to Allen; no remote access. | 2026-10-06 |

---

## 4. Section 3 — Setup conversation (**approved**, see D21/D22)

- **Bootstrap:** client tells their agent "Install the solution from
  `<url>`". URL serves agent-readable `INSTALL.md`: install CLI, run
  `installer start`, loop `next`/`submit` until `report`. Agent rules:
  never invent answers; always show *why*; never handle secrets in chat;
  stop at blocking human steps with resume instructions; `verify` after
  every agent action.
- **Phases:** 0 PREFLIGHT · 1 MODE · 2 BRAIN · 3 DATA · 4 CHANNELS ·
  5 WORKFLOWS · 6 DRY RUN · 7 ACTIVATE · 8 REPORT. Industry content enters
  only as data (recipe suggestions + required connectors).
- **Step protocol (JSON):** `step_id, phase, type, title, why,
  instructions, input{kind}, blocking, est_minutes, resume`.
  Types: `ask` · `human_action` · `agent_action` (intent + verify) · `auto`
  (CLI) · `verify`.
- **Secrets bypass the agent:** `input.kind: secret | oauth` handled by the
  CLI directly, stored in OS keychain; agent only sees "done".
- **Connector definition:** `id, provides_tools, mcp{package, version,
  transport}, auth{kind, provider, scopes, modes}, setup[], verify, risk`.
  Prefer wrapping existing MCP servers, **pinned + vetted by Allen**
  (supply-chain risk). `risk` feeds approval defaults.
- **State:** `.installer/state.json`, per-step `pending|done|blocked|
  skipped`; idempotent; `installer resume` safe days later.
- **Report:** ✅ Ready / ⚠️ Ready with limits / ⛔ Blocked; sections Working /
  Limited / Needs you / Evals; posted to team channel once connected.
- **Team host:** `installer invite` → per-member join links (team channel +
  personal OAuth).

### Secret / OAuth entry UX — decided (D22)
Local browser page served by the CLI; one-time link fallback on headless
hosts.

---

## 5. Open conflicts

### 5.1 Emergency bypass vs. forced approval — RESOLVED by D26
`property-management-skills/property-db/references/hitl-rules.md` and
`docs/architecture.md` say **"Emergency situations: bypass HITL, notify
operator immediately."** D24 forbids auto-approval of money/outbound
actions. Resolution adopted (D26), except item 3 changed by user: emergencies bypass
the *queue wait* only for **L1 internal alerts** (page the team / on-call
immediately, escalating channel); vendor dispatch (financial + outbound)
still needs a human, via an urgent fast-path approval; tenant safety
instructions (e.g. "shut the water valve, leave if you smell gas") are
pre-approved fixed templates, not model-written.

## 6. Open items to verify (before the spec)

### Verified 2026-10-06 (Claude Code 2.1.292, live test)
- `claude -p … --output-format json --json-schema '<schema>'` returns
  `structured_output` matching the schema (tested enum classification) and
  a `session_id`.
- `claude -p … -r <session_id>` resumes that session headless (recalled a
  word from the first call; same session id).
- Available for judge isolation: `--allowedTools` / `--disallowedTools`,
  `--strict-mcp-config`, `--mcp-config`, `--restricted`, `--model`.
- Codex: not installed locally, so **not live-tested**. Documented in
  third-party guides (not yet official docs): `codex exec` headless,
  `codex exec resume <SESSION_ID>` / `--last`, `--output-schema`, `--json`
  event stream, `CODEX_API_KEY` for unattended runs; `--output-schema` on
  `exec resume` reportedly since a 2026 release. **Live test still
  required before the spec is final.**

### Documented, not tested (2026-10-06 web)
- Pi (`@mariozechner/pi-coding-agent`): `pi -p`, `--mode json` (JSONL),
  resume via session id from the session header line.
- WorkBuddy (Tencent): desktop agent, OpenClaw-compatible skills, MCP
  support, official CLI (wrapped by community `workbuddy-mcp`).

### Still open
- Codex: Agent Skills support; scheduled automations; `codex exec` output
  schema support.
- OpenClaw / Hermes: skills directory, MCP config format, headless CLI/API.
- Claude Code: headless `-p` JSON schema flag; tool restriction for judge
  calls.
- OAuth redirect to a headless team host (loopback vs tunnel); Google
  Workspace internal-app path; Microsoft 365 admin consent.
- Skills Wiki `enterprise` routes — do they support team seats?
- Whether hosted eval can run unattended inside an install.
- n8n MCP node details (only if n8n backend is ever offered).

## 7. Skills Wiki-side work identified (optional, Allen's side)
- (Found while writing the spec) `POST /api/combos/activate` accepts only a
  dashboard session / anon cookie, not the API key → phase-2 combo
  activation is a `human_action` until an API-key path exists.
- Add `evals/tasks.jsonl` + `rubric.json` to `maintenance_triage` and
  `real_estate_tenancy_assistant`.
- Add a `<workflow>` block to the realtor combo (+ allowlist) if
  `combo_gate` is wanted.
- Publish recipes as file resources in a pack.
- Realtor skill fixes from §1.3.

## 8. Next steps
1. ~~Approve Section 3~~ (done).
2. ~~All design sections~~ done (Sections 3–8 + conformance); data layer (Sheets /
   SQLite / Supabase); channel layer; testing & evaluation of the installer
   itself (CI across runtimes); security model.
3. Resolve §5 conflicts and §6 verifications.
4. Write spec → `docs/superpowers/specs/YYYY-MM-DD-installer-design.md`
   → user review → writing-plans.

## 9. Follow-up edits required in existing skills (not done yet)
- `property-management-skills/property-db/references/hitl-rules.md` and
  `docs/architecture.md`: replace "Emergency situations: bypass HITL" with
  the D26 rule (alert decision maker immediately; dispatch and any external
  message still need human approval).
