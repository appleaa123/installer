# taskfollow

TaskFollow is a thin layer on top of the AI agent a business owner already has
(Claude Code first). It does not change the agent or add capabilities to it; it
makes that agent "vertical": step-by-step setup, finding and running the owner's
workflows (a schedule and a run record), and reminding the agent which skills each
workflow uses, from Skills Wiki or the agent's own skills. The agent's model gathers
the inputs and decides; TaskFollow executes what it can or says plainly what is
missing. Money, legal matters, messages to customers and deletes always ask a person.
The v1 scope is `docs/scope-refresh.md`, section 9.

**New to this? Read [`START-HERE.md`](START-HERE.md).** It takes you from nothing to a helper that sets everything up for you.

Status: Plans 1–11 implemented; see the [roadmap](docs/superpowers/plans/README.md).
The package is not published (`"private": true`).

Who can use it today: a person on a **Mac** or on **Windows 11 (Preview)**, with
**Node 22 or newer**, an AI agent such as Claude Code that follows
[`INSTALL.md`](INSTALL.md), and the one service a workflow reads (Telegram,
email, Slack and a Google Sheet are optional). A Skills Wiki account
is optional (INSTALL.md, section 11). Windows has not yet been tried on a real PC
(human task 22) and has no always-on team host; Linux is untested.

## What is certified

Support tiers follow spec §7.5. A runtime is **Certified** on a platform
only when a person ran `taskfollow certify` there from a clean checkout and
every check passed: the offline suite, every live check with its keys, and
the real agent's probe (D116). Nothing is certified by a CI service (O7,
D48). The record a run writes says which tier it reached and why.

| Runtime | Profile | macOS | Linux | Windows | Notes |
|---|---|---|---|---|---|
| Claude Code | `claude-code` | **Certified** 2026-10-12 (commit `437692c`, Claude Code 2.1.296, Node 22.14.0, macOS on Intel) | Not certified yet | Unknown | First real certification run (task 14): 1,360 offline and 18 live tests passed. Linux and Windows need a run of their own (task 16, D115). |
| Codex CLI | `codex` | Unknown | Unknown | Unknown | Its terms were reviewed and allow it (O2, D121). Its flags come from Codex's documentation and were not run (O1, task 15), so it stays Unknown until a certification passes. |
| Antigravity | none | — | — | — | Never run by the installer: its terms forbid invocation by other programs (D32, D114). |
| Any other agent | none | Unknown | Unknown | Unknown | The probe decides; the fallbacks apply (§7.4). |

When a certification passes, put its date, commit and agent version in
this table (see [`docs/release-checklist.md`](docs/release-checklist.md)).

## Development

- `npm test`: the offline suite (fakes only: no network, no real agent).
- `npm run test:live`: the opt-in live checks, with your own keys in the
  environment (D48).
- `npm run certify -- --profile claude-code --home ~/installer-certification`:
  certify a runtime on this machine (D116;
  [guide](docs/testing/2026-10-09-plan-10-live-test.md)).
- Design spec: [`docs/superpowers/specs/2026-10-06-installer-design.md`](docs/superpowers/specs/2026-10-06-installer-design.md)
- Decision log: [`DECISIONS.md`](DECISIONS.md)
- Release checklist: [`docs/release-checklist.md`](docs/release-checklist.md)
