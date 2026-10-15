# TaskFollow: where things stand and what to do next

Last updated 2026-10-15.

## Done (all in pull requests, none merged)

Stacked in order. Merge from the bottom up: change each PR's base to `main` after the one below it lands, and don't delete branches.

| PR | Branch | What it does | Decision |
|---|---|---|---|
| #31 | `feat/agent-tasks` | Workflows hand work to the person's own agent (MCP servers, CLIs such as the Shopify CLI). Restricted run, a hook as the gate, every call recorded with the agent's reason, `taskfollow why`. | D136–D142 |
| #32 | `feat/email-reply` | Reads HTML-only email; replies stay in the customer's thread (`reply_to`). | D143 |
| #33 | `feat/calc` | `calc` step for report numbers; comparison with the previous run (`previous.<step>`). | D144 |
| #34 | `feat/store-example` | Setup interview ("walk me through your week"); two Shopify example workflows in INSTALL.md §9b (tested as written). Starter 1.6.0. | D145 |
| #35 | `feat/watch` | Opt-in record of the agent's direct calls to watched services (hook in `~/.claude/settings.json`); `why direct`. | D146 |
| #36 | `feat/watch-ask` | Always-ask list (Claude Code's own `permissions.ask`); "I noticed" suggestions, sent only to the person who asked. | D147, D148 |
| #37 | `feat/whatsapp` | WhatsApp for customers through a relay in the client's own Cloudflare account; 24-hour window; 3-step setup page. Starter 1.7.0. | D149 |
| (not opened yet) | `feat/codex` | Task 25 and 26 follow-ups: the record keeps constants like `CREATED_AT`; the task gate waits 30 s, not 5; `watch on`/`ask` refuse for agents other than Claude Code; `unask` leaves no empty `permissions` and says what it did. Codex research and reviewed plan, postponed. | D150 |

Last full test run: 134 files, 1,861 tests. Everything is tested against fakes only.

## For you to do (checklists in `docs/human-tasks.md`)

1. ~~Task 25~~ **done 2026-10-15**: one bug found and fixed (Claude Code's `StructuredOutput` tool), now on #31–#37; your MCP servers do load in restricted mode.
2. ~~Task 26~~ **done 2026-10-15**: all six steps passed; an ask rule wins over an allow rule for the same command.
3. **Task 27 (about 1 hour).** WhatsApp with Meta's free test number and a free Cloudflare account.
4. **Tasks 21–24, still open.** Real mailboxes (21), a Windows 11 PC (22), a real-person install test (23), a real Slack workspace (24).
5. **Merge #31 → #37** when you're ready. Ask Claude first if you want help; Claude never merges without your go-ahead.
6. **Publish to npm.** Needs your account: the `taskfollow` package, so `npx --yes taskfollow instructions` works.
7. **On or after 2026-10-22:** re-run the Google token check and record the result in D123.

## Postponed on purpose (next coding work, in suggested order)

1. **Codex and other agents: researched and postponed (D150).** No Codex account to prove it in real use. The reviewed plan with Fable's 20 findings is in `docs/superpowers/plans/2026-10-15-codex-agents.md`; pick it up when someone can test with Codex (a pay-per-use OpenAI API key would do).
2. **Draft → a person approves → the agent publishes**, for changes made through the agent (for example a Shopify product). Needs its own design, so that the approved thing is exactly what gets published. Sending to customers already works this way.
3. **`why` as an MCP tool** (today it's a CLI command the agent can run).
4. **WhatsApp extras:** message templates, media, team members on WhatsApp.
5. **Re-run certification** on the final build.
6. **Find the cause of the flaky `tests/unit/shadow.test.ts`** (failed once under full-suite load, passes alone).

## Rules to keep

- Ask before merging any PR.
- Never paste keys or tokens into chat; they're entered only on the local setup pages.
- Client data and keys live in the client's own accounts, never the owner's.
- Tests must never touch the real `~/.claude`: after each test run, `claude mcp list` should show no installer or taskfollow entries, and `~/.claude/settings.json` should have no `watch-hook`.
- Write the plan first, have Fable review it (it found real problems every time), then build test-first.
- Don't edit files while the full test suite is running.
