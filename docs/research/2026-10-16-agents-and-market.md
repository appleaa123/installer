# Agents and the small-business market: research of 2026-10-15/16

Gathered for the owner's questions on 2026-10-16: *why TaskFollow rather than OpenClaw or Hermes; what about Claude Cowork and Google; why small businesses still pay someone to build agents.* Sources were read on 2026-10-15/16 by research agents; secondary or weak sources are marked. Conclusions and the owner's decisions are in `docs/scope-refresh.md` 9.15 and D156.

## OpenClaw and Hermes Agent

| | OpenClaw (2026.9.33 stable, 15 Oct) | Hermes Agent (v0.22.2, 15 Oct) |
|---|---|---|
| Install | Command line only (`npm i -g openclaw`, `openclaw onboard`) | Signed desktop apps with a guided setup chat since v0.22.0 (13–14 Oct) |
| Models and subscriptions | API keys recommended for Claude (a Claude Code login or setup token "expires and can be revoked"); ChatGPT/Codex subscription login officially supported (OpenAI allows it in external tools); Google API key only | Claude login only with Max plus purchased extra usage; ChatGPT device login for Codex models; Google API key only |
| Schedules, speaks first | Built-in cron, delivers to chat; heartbeat check-ins opt-in | Built-in cron with natural-language jobs |
| Channels | WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Teams, 20+ | Telegram, Discord, Slack, WhatsApp, Signal, email |
| Skills | ClawHub registry; malicious-skill campaign early 2026 (hundreds to 1,000+, secondary) | Skills Hub with a scanner; ~600 reviewed plugins |
| Approval gate | Code-enforced for shell/exec only; a "payment" or "message-send" label "never grants authorization"; no send/pay gate | Code-enforced for shell commands; no gate for sending or paying (browser card checkout only) |
| Suggests automations from repeated work | Not built in (third-party skill only) | Refines its own skills; does not propose automations |
| Tests and reports its own abilities | Not found (`openclaw doctor` = health) | Not found (`hermes doctor` = health, advisories) |
| Record of why | Logs, transcripts; no reasons | Logs, sessions, approval decisions; no reasons |

Sources: github.com/openclaw/openclaw, docs.openclaw.ai (providers/anthropic, providers/openai, providers/google, automation/cron-jobs, gateway/heartbeat, tools/exec-approvals, logging); github.com/NousResearch/hermes-agent (README, releases), hermes-agent.nousresearch.com/docs (providers, skills, security, curator). Security figures: bitdoze.com, insiderllm.com, techradar.com (secondary, conflicting).

## Claude Cowork (Anthropic)

- Claude's agentic mode in the desktop app; sessions run in an isolated cloud environment and reach the computer through Claude Desktop. Plans: Pro, Max, Team, Enterprise.
- **Scheduled tasks on all paid plans run remotely "even when your computer is asleep"**; a task that needs local files or apps runs only on the computer (support.claude.com articles 13364135 and 13854387, read 2026-10-15).
- **Same `SKILL.md` format** in Chat, Cowork and Claude Code; plugins (skills, agents, hooks) from Anthropic's marketplace or **any GitHub/GitLab/Bitbucket repo added as a marketplace**; local MCP servers load only when the session runs on the computer (claude.com/docs/plugins/platform-support).
- Projects hold folders, standing instructions and memory. **Whether Cowork reads a project's `CLAUDE.md` is not documented**; the owner expects it does (assumption, to check in the final human session).
- Approvals: three modes (automatic with Claude's own review, manual, skip all); always asks before permanently deleting files; payments get "strong guidance to require explicit confirmation", not a hard gate; no hard rule before sending email found.
- Anthropic ships a **"Claude for Small Business" Cowork plugin** (QuickBooks/PayPal reconciliation tutorial; launch details conflict across secondary sources).

## Google

Gemini CLI and Code Assist stopped serving Google AI Pro/Ultra on 18 Jun 2026 (developers.googleblog.com, 19 May 2026); the consumer successor is Antigravity CLI (`agy`). Antigravity's terms (§6) call third-party access to the service a breach that may suspend the account; there is **no documented, sanctioned path for unattended scheduled use on a consumer plan** (forum answers only, secondary). D114 holds.

## Running first-party agents on a subscription

- **Claude Code:** `claude -p` uses the subscription login; OAuth is "intended exclusively" for ordinary use of Claude Code and Anthropic's own apps, and plan limits "assume ordinary, individual usage"; `--bare`, recommended for scripts, needs an API key (code.claude.com legal-and-compliance, headless). Third-party harnesses moved off subscription limits from 4 Apr 2026 (infoworld.com, secondary). TaskFollow runs Claude Code itself, a first-party use; how many unattended runs count as "ordinary" is the open edge.
- **Codex CLI:** API keys recommended for automation; copying the ChatGPT login to a headless machine documented as a fallback.

## Why small and mid-size businesses still hire help

- **Barriers are trust, understanding and accuracy, not cost.** Intuit 2026 AI Impact Report (34k SMBs; figures for US non-adopters): privacy/security 36%, not understanding what AI can do 28%, inaccurate output 26%; cost "not the biggest hurdle". Across all US SMBs, 77% use AI regularly but about 1 in 10 pay for a dedicated AI tool. OECD (5,000 SMEs, late 2024): "unsuitable to our work" 57%, legal 54%, data 52%, staff skills 50%. Australia NAIC (Feb 2026): ~65% of non-adopters cite distrust or a preference for human control. Salesforce SMB Trends 2025: security the top tech challenge; 81% would spend more with trusted vendors.
- **Help from outside works better** (enterprise-weighted): MIT NANDA via Fortune (Aug 2025): vendor or partner projects succeed ~67% of the time, internal builds about a third as often. Gartner (Jun 2025, secondary): over 40% of agentic AI projects cancelled by end-2027.
- **What agencies sell** (weak, self-reported): mostly n8n/Make/Zapier workflows with AI steps, integration and a maintenance retainer; setup ~$1.5k–5k, retainer ~$300–1,500 a month. Upwork (Feb 2026): AI integration skills +178% year on year.
- **Done-for-you vs guided do-it-yourself:** no survey asks directly; the indirect evidence leans to "with help, and with me in control".
