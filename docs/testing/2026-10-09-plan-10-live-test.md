# Plan 10 live test guide (certifying a runtime on your machine)

Use this guide to certify Claude Code on your own Mac with `installer certify` (D116). Each test gives the commands
to run, what you should see, and a place to record what you actually saw. If a result differs, collect the items in
**Diagnostics to capture** at the end of the [Plan 1 guide](2026-10-07-plan-1-live-test.md#diagnostics-to-capture).

The **Expected** lines are predictions: the automated tests replace every suite and the agent with fakes, so
`installer certify` has never run its real suites. The counts are those of the branch when this plan was written
(100 test files, 1358 tests offline; 7 files, 20 tests live; the run that certified Claude Code on 2026-10-12 saw 100 files, 1,360 tests offline and 7 files, 18 tests live with none skipped); later commits change them.

**What this guide changes:** Test 1 and Test 2 run the offline suite (about three minutes, nothing leaves your
machine) and then the live checks. Without keys (Test 1) the live checks make one `claude -p` call. With your keys
(Test 2) they also send one Telegram message to your test chat and one email from your test mailbox to itself, add a
tab to your test spreadsheet and delete it again, read Skills Wiki (read only), register a temporary
`swtest-installer` server in your Claude Code and a temporary `skillswiki-live` keychain item and remove both, and
make about six short `claude -p` calls on your subscription. The record goes to `~/installer-certification`. No OS
setting is changed and nothing is published.

## What this build can and cannot do

Plan 10 adds: `installer certify --profile <id>` (also `npm run certify -- …`), which runs the offline suite, the
live checks and the probe on the real agent and writes a dated record with its tier (§7.5: Certified only when
everything ran and passed from a clean checkout); `installer version`; the Codex profile (written from Codex's
documentation, not run yet, terms pending: used only when named, tier Unknown); Windows support for npm-installed
agents without a shell (not yet run on Windows: Unknown); the universal injection suite and the connector contract
checks, which run inside the offline and live suites. Not yet: certified Codex or Windows runs (human tasks 15–17),
profiles for other agents (O5), clean VMs or repeated runs, publishing (D120).

## Results summary

| Test | What it checks | Pass / Fail | Notes |
|---|---|---|---|
| 0 | Setup: a clean checkout, built | Pass | Clean tree, commit 437692c, Node v22.14.0 |
| 1 | Certify without keys: Compatible, and the reasons name every missing key | Skipped | Not needed once Test 2 passed |
| 2 | Certify with every key: Certified | Pass | Certified: offline 1,360, live 18 of 18, no skips |
| 3 | The record names the commit you tested | Pass | Record names commit 437692c, file mode 0600 |
| 4 | The injection suite and the contract checks, by name | Pass | 3 files, 51 tests |
| 5 | Optional: Codex stays Unknown while its terms are pending | Skipped | Codex is not installed (task 15) |
| 6 | The package: what `npm pack` would ship | Pass | Package ships the profiles, connector, starter and INSTALL.md; no tests/ or src/ |

---

## Test 0: Setup

Open a new terminal, so no key from an earlier test is set.

```bash
export REPO=/Users/allenliu/Desktop/ML-Project/installer
export C=~/installer-certification
cd $REPO
git status --short
node --version
npm ci && npm run build
node dist/cli.js version
```

**Expected:** `git status --short` prints nothing (commit or stash first: a checkout with changes is never
Certified). Node is v22 or later. `version` prints `{"installer":"0.1.0","node":"v22.…"}`.

**Actual:**

Clean tree, commit `437692c`, Node v22.14.0, `version` printed `{"installer":"0.1.0","node":"v22.14.0"}`.

---

## Test 1: Certify without keys

```bash
npm run certify -- --profile claude-code --home $C
```

**Expected:** after about three minutes, one JSON record (also written to
`$C/certification/<time>-claude-code.json`) with `"profile":"claude-code"`, your `"agent_version"`,
`"offline":{"status":"passed","files":100,"tests":1358,"passed":1358,"failed":0,"skipped":0}`, `"live"` with
`"status":"passed"`, `"files":7`, `"tests":20`, one passed (the judge call), the rest skipped, and `"missing"` listing
every key name and `INSTALLER_LIVE_AGENT=1`; `"probe"` with `c4_headless`, `c4_schema` and `c5_resume` `true`;
`"tier":"compatible"` and `"reasons":["the live checks lacked SKILLSWIKI_API_KEY, …, INSTALLER_LIVE_AGENT=1"]`. No key
value appears anywhere in it, only names.

**Actual:**

Skipped.

---

## Test 2: Certify with every key

Use the `<pack>/<skill>` of the Plan 3 guide and the skill file of the Plan 9 guide.

```bash
set -a; . ~/.config/installer-dev/.env; set +a
export INSTALLER_LIVE_AGENT=1
export SKILLSWIKI_LIVE_RESOURCE=<pack>/<skill>
export SKILLSWIKI_LIVE_FILE=<pack>/<skill>/<path>
npm run certify -- --profile claude-code --home $C
```

**Expected:** `"live":{"status":"passed","files":7,"tests":18,"passed":18,"failed":0,"skipped":0,"missing":[]}` (the guide first predicted 20 tests with two skipped Telegram reads; the real suite has 18 and none are skipped),
`"dirty":false`, `"tier":"certified"` and `"reasons":[]`. One message arrives in your test chat and one email in your
test mailbox, both starting `installer contract check`; you can delete them. If the tier is not `certified`, the
`reasons` say why: a failed live check names itself in the vitest output only, so then also run
`npm run test:live` and paste its failures.

**Actual (paste the whole record):**

First attempt: `"tier":"compatible"`, `"reasons":["the live checks failed"]`: the Google refresh token in `.env` had been revoked when the app's access was removed at the end of the Plan 5 guide (`invalid_grant`), so the Google file could not run. After signing in again and reloading the `.env` into the terminal (a running terminal keeps the old values), the second run: `"offline":{"status":"passed","files":100,"tests":1360,"passed":1360,"failed":0,"skipped":0}`, `"live":{"status":"passed","files":7,"tests":18,"passed":18,"failed":0,"skipped":0,"missing":[]}`, `"dirty":false`, probe C4, C4 schema and C5 true, `"tos_review":"ok"`, `"tier":"certified"`, `"reasons":[]`, Claude Code 2.1.296, `darwin x64`, commit `437692c33fc93d4d8df6b6b415440ea1c649ce23`. Do not remove the Google app's access before certifying.

---

## Test 3: The record names the commit you tested

```bash
R=$(ls -t $C/certification/*-claude-code.json | head -1)
node -e 'const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); console.log(r.tier, r.commit, r.dirty, r.agent_version, r.platform)' $R
git rev-parse HEAD
ls -l $R
```

**Expected:** `certified <commit> false <your Claude Code version> darwin arm64` (or `x64`), the same commit as
`git rev-parse HEAD`, and the file is `-rw-------` (0600).

**Actual:**

`certified 437692c33fc93d4d8df6b6b415440ea1c649ce23 false 2.1.296 darwin x64`; `git rev-parse HEAD` printed the same commit; the file is `-rw-------`.

---

## Test 4: The injection suite and the contract checks, by name

They ran inside Test 1 and Test 2; this shows them on their own (offline, about ten seconds).

```bash
npx vitest run tests/unit/injection-inbound.test.ts tests/unit/injection-runs.test.ts tests/unit/contracts.test.ts
```

**Expected:** `3 passed` files and `51 passed` tests: every attempt flagged and changing nothing, through Telegram,
email, a sheet cell, a judged message, a skill file and an agent's inbox; and the Sheets, Telegram and email
contracts against the fakes.

**Actual:**

`Test Files  3 passed (3)` and `Tests  51 passed (51)`.

---

## Test 5 (optional, after human task 15): certify Codex (terms reviewed `ok`, D121)

```bash
npm run certify -- --profile codex --home $C
```

**Expected:** `"tos_review":"ok"` (D121). With Codex installed, the probe's `c4_headless`,
`c4_schema` and `c5_resume` show whether the documented flags work (O1); the tier is `unknown` until they pass and
the other conditions hold. Without Codex installed, `"tier":"unknown"` and the reasons say
`the agent did not pass C4, C4 schema and C5`. The live judge call runs through Codex; the C6 rehearsal is skipped
(the profile has no MCP templates).

**Actual:**

Skipped (Codex is not installed).

---

## Test 6: The package

```bash
npm pack --dry-run 2>&1 | grep -E 'dist/cli.js|profiles/|connectors/|solutions/|INSTALL.md|tests/|src/'
```

**Expected:** `dist/cli.js`, `profiles/claude-code.json`, `profiles/codex.json`,
`connectors/google-sheets/1/connector.json`, `solutions/starter.json` and `INSTALL.md`, and no line with `tests/` or
`src/`. Nothing is published (`"private": true`).

**Actual:**

`dist/cli.js`, `profiles/claude-code.json`, `profiles/codex.json`, `connectors/google-sheets/1/connector.json`, `solutions/starter.json` and `INSTALL.md` are listed; nothing from `tests/` or `src/`. No `swtest-installer` or `skillswiki` server was left in Claude Code.

---

## Clean up

Keep `$C`: its records are the evidence for the README's "What is certified" table. The live checks removed their
temporary Skills Wiki registration, keychain item and spreadsheet tab themselves; check with `claude mcp list` that no
`swtest-installer` server is left. Close the terminal, so the keys you sourced are gone.
