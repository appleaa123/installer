# Plan 3 live test guide (secrets + BRAIN phase)

Use this guide to install the `installer` CLI on your own machine and check Plan 3 by hand, against your real
Claude Code, your real macOS keychain and the hosted Skills Wiki. Each test gives the commands to run, what you
should see, and a place to record what you actually saw. If a result differs, collect the items in
**Diagnostics to capture** at the end of the [Plan 1 guide](2026-10-07-plan-1-live-test.md#diagnostics-to-capture).

The **Expected** lines below are what the plan predicts; unlike the Plan 1 and Plan 2 guides they were not yet
produced by running the commands. The first person to run this guide replaces them with the actual output.

## What this build can and cannot do

Plan 3 adds: `installer secret skillswiki` (a local page that stores the key in your keychain), the engine-run
registration of the Skills Wiki MCP server in Claude Code with a headers helper (the key never enters the agent's
context), the combo step checked through `get_active_combo`, the C6 probe (`level 3 of 3`), `skillswiki:`
solution references, `installer disconnect skillswiki`, and opt-in live tests (`npm run test:live`).
It cannot yet enter OAuth sign-ins, connect data or channels: that is Plan 5 and later.

The C6 probe makes one headless Claude Code call with one MCP tool allowed, so it uses a little of your plan or credit.
Registration writes the server `skillswiki` to your **user** Claude Code config; Test 7 removes it.

## Results summary

| Test | What it checks | Pass / Fail | Notes |
|---|---|---|---|
| 0 | Setup and install | Pass | Commit 2fb8356 |
| 1 | The secret page stores the key in the keychain | Pass | 47 chars stored; page process exited |
| 2 | `mcp-headers` prints the header; nothing else sees the key | Pass | Header printed (key masked), exit 0 / exit 1 |
| 3 | Starter install through the BRAIN phase to level 3 of 3 | Pass | Level 3 of 3, agent 2.1.296 |
| 4 | Workspace trust missing: level 2 of 3 with the folder named | Pass | Level 3 of 3, no trust note: `claude -p` did not treat the new folder as untrusted |
| 5 | A `skillswiki:` reference | Partial | Failure case passes (exit 2, no folder); message is `returned no content`; recipe case skipped (none published) |
| 6 | A wrong key is named, nothing is created | Pass after fix | Live server answers a wrong key with 403 (F1, fixed); `installer resume` needed after 3 failed verifies (F2) |
| 7 | `disconnect` removes the server and the key | Pass | Matches Expected |
| 8 | Opt-in live tests | Pass after fix | Wrong-key live test failed on 403 before the fix; C6 rehearsal passed and cleaned up |
| 9 | Clean up | Pass | Folder and keychain item gone |

---

## Test 0: Setup and install

```bash
export T=~/installer-plan3-test
export REPO=/Users/allenliu/Desktop/ML-Project/installer
export PREFIX=$T/npm
mkdir -p $T $PREFIX

node --version            # must be v22 or later
cd $REPO && git log --oneline -1

npm install && npm run build && npm pack --pack-destination $T
npm install -g --prefix $PREFIX $T/installer-0.1.0.tgz
export PATH=$PREFIX/bin:$PATH
which installer
set -a; . ~/.config/installer-dev/.env; set +a      # exports SKILLSWIKI_API_KEY and SKILLSWIKI_MCP_URL for Tests 5 and 8
cd $T
```

**Expected:** `which installer` prints `<your home>/installer-plan3-test/npm/bin/installer`.

**Record:**
- Commit shown by `git log`:
- `which installer` printed:
- Pass / Fail:

---

## Test 1: The secret page stores the key in the keychain

```bash
installer secret skillswiki
echo $?
```

**Expected:** one line such as `{"status":"waiting","url":"http://127.0.0.1:54321/s/<64 hex>","pid":12345}`, exit `0`,
and the page opens in your browser at once (the command does not wait). Paste your Skills Wiki API key, press **Save**.

- The page says **Done, you can close this tab.** Reloading it fails (the page process has exited; `ps -p <pid>` prints nothing).
- `security find-generic-password -s installer -a skillswiki -w` prints the key; `ps -o args= -p <pid>` never showed it (the value went in on stdin).
- A second `installer secret skillswiki` opens a new page; saving there replaces the key (`-U`).
- Opening the url with a different token, or sending a POST from another origin, is refused (404 / 403); nothing changes.

**Record:**
- Output line:
- Keychain shows the key:
- Pass / Fail:

---

## Test 2: `mcp-headers` prints the header; nothing else sees the key

```bash
installer mcp-headers skillswiki; echo " exit=$?"
installer mcp-headers nothing-stored; echo " exit=$?"
```

**Expected:**

```
{"Authorization":"Bearer <your key>"}
 exit=0
 exit=1
```

The second line prints nothing at all on stdout or stderr before `exit=1`.

**Record:**
- Pass / Fail:

---

## Test 3: Starter install through the BRAIN phase to level 3 of 3

Run this from a folder Claude Code trusts (one you have opened Claude Code in and accepted), because the C6 probe
runs in the folder where `start` is run:

```bash
cd $REPO
installer --home $T/h1 start --solution file:$REPO/solutions/starter.json --url "$SKILLSWIKI_MCP_URL"
installer --home $T/h1 submit mode.shared-work --value '"yes"'
installer --home $T/h1 submit mode.always-on --value '"no"'
installer --home $T/h1 submit mode.decision-maker --value '"Owner"'
installer --home $T/h1 verify brain.key
claude mcp get skillswiki
installer --home $T/h1 next
```

**Expected:**
- `start` probes the agent first (10–30 seconds), then shows `mode.shared-work`; the submits lead to `brain.key`
  (a `human_action` with `"input":{"kind":"secret","provider":"skillswiki"}`).
- `verify brain.key` prints `{"status":"passed","next":{"status":"step","view":{"step":{"step_id":"brain.combo",…`:
  the registration step `brain.register` ran in between.
- `claude mcp get skillswiki` shows `Scope: User config (available in all your projects)`, `Type: http`, your URL,
  and connects (the helper supplied the header).
- `next` shows `brain.combo`. Activate the combo in your Skills Wiki dashboard, then:

```bash
installer --home $T/h1 verify brain.combo
installer --home $T/h1 report
node -e 'const s=require(process.argv[1]);console.log(JSON.stringify(s.runtime),s.work_dir)' $T/h1/state/install-state.json
```

- `verify brain.combo` prints `{"status":"passed","next":{"status":"complete"}}` (the C6 probe ran after it; allow 10–60 seconds).
- The report starts with `✅ READY  (10 of 10 steps done) · starter@1.0.0` and has the line
  `🤖 Agent      claude-code 2.1.294 — level 3 of 3` (your version may be newer).
- The last command prints `"c6_mcp":true,"support_level":3` inside the runtime, and your repo folder as `work_dir`.
- Running `verify brain.combo` **before** activating a combo prints
  `{"status":"failed","hint":"No combo is active yet: activate one in your Skills Wiki dashboard, then run the verify again","retry":true,…}`.

**Record:**
- `claude mcp get skillswiki` output:
- Report:
- Runtime line:
- Pass / Fail:

---

## Test 4: Workspace trust missing: level 2 of 3 with the folder named

```bash
mkdir -p $T/untrusted && cd $T/untrusted
installer --home $T/h2 start --solution file:$REPO/solutions/starter.json --url "$SKILLSWIKI_MCP_URL"
installer --home $T/h2 submit mode.shared-work --value '"no"'
installer --home $T/h2 submit mode.always-on --value '"no"'
installer --home $T/h2 submit mode.decision-maker --value '"Owner"'
installer --home $T/h2 verify brain.key
installer --home $T/h2 verify brain.combo
installer --home $T/h2 report
cd $T
```

**Expected:** the install still completes. The report says `⚠️ READY WITH LIMITS  (10 of 10 steps done)` and
`🤖 Agent      claude-code 2.1.294 — level 2 of 3 (no MCP client; Skills Wiki content is inlined)`;
`runtime.notes` in `$T/h2/state/install-state.json` contains
`workspace trust may be missing in <your home>/installer-plan3-test/untrusted (open the agent there once and accept the folder)`.
(If Claude Code treats the new folder as trusted on your machine, record that instead; the note then does not appear.)

**Record:**
- Report:
- Note:
- Pass / Fail:

---

## Test 5: A `skillswiki:` reference

Needs a recipe published as a skill file resource. Set `REF` to one you have (for example
`skillswiki:<pack>/<skill>/recipe.json`); if you have none, record "no published recipe" and skip.

```bash
export REF=skillswiki:<pack>/<skill>/recipe.json
installer --home $T/h3 start --solution $REF --url "$SKILLSWIKI_MCP_URL"
head -c 300 $T/h3/solution/solution.json
installer --home $T/h3 start --solution $REF
```

**Expected:** the first `start` fetches the recipe through `get_skill_resource` and prints its first step; the pinned
file is the recipe's JSON without any `<skill_reference>` wrapper; the second `start` (no `--url`) prints the same step
and changes nothing. `installer --home $T/h4 start --solution skillswiki:none/none/none.json --url "$SKILLSWIKI_MCP_URL"`
exits `2` and creates no `$T/h4`. The message is `Skills Wiki could not serve 'skillswiki:none/none/none.json': …` when the server answers with an error, or `Skills Wiki returned no content for 'skillswiki:none/none/none.json'` when it answers with a success result that has no text (what the hosted server did on 2026-10-12).

**Record:**
- Ref used: none published; the failure case only (`skillswiki:none/none/none.json`)
- Pass / Fail: Partial: `Skills Wiki returned no content for …`, exit 2, no `h4` folder; the recipe case was skipped

---

## Test 6: A wrong key is named, nothing is created

```bash
installer secret skillswiki        # enter the word wrong-key on the page
installer --home $T/h5 start --solution file:$REPO/solutions/starter.json --url "$SKILLSWIKI_MCP_URL"
installer --home $T/h5 submit mode.shared-work --value '"no"'
installer --home $T/h5 submit mode.always-on --value '"no"'
installer --home $T/h5 submit mode.decision-maker --value '"Owner"'
installer --home $T/h5 verify brain.key
installer --home $T/h5 verify brain.combo
```

**Expected:** `verify brain.combo` prints
`{"status":"failed","hint":"Skills Wiki key rejected: run `installer secret skillswiki`","retry":true,…}`.
The hosted server answers a wrong key with 403 since 2026-10-12 (it answered 401 on 2026-10-08); both give this hint. After three failed verifies the step is blocked: run `installer --home $T/h5 resume` first. Enter the real key again through `installer secret skillswiki`, then `installer --home $T/h5 verify brain.combo` passes.

**Record:**
- Pass / Fail: Pass after the 403 fix. Before it, the hint was `Skills Wiki answered HTTP 403` (F1); after the third failure the step was blocked until `installer resume` (F2, documented above). The real key restored: 47 characters, verify passed.

---

## Test 7: `disconnect` removes the server and the key

```bash
installer --home $T/h1 disconnect skillswiki
claude mcp get skillswiki; echo " exit=$?"
security find-generic-password -s installer -a skillswiki -w; echo " exit=$?"
tail -1 $T/h1/audit/audit.jsonl
installer --home $T/h1 disconnect skillswiki
```

**Expected:**

```
{"status":"disconnected","unregistered":true,"secret_deleted":true}
No MCP server named "skillswiki". …
 exit=1
 exit=44
{"seq":…,"event":"secret.disconnected","ref":"skillswiki",…}
{"status":"disconnected","unregistered":false,"secret_deleted":false}
```

**Record:**
- Pass / Fail:

---

## Test 8: Opt-in live tests

```bash
cd $REPO
npm run test:live                                   # hosted Skills Wiki only; 4 tests, 1 or 2 skipped
INSTALLER_LIVE_AGENT=1 npm run test:live            # adds the real Claude Code C6 rehearsal (costs tokens)
npm test                                            # the offline suite never runs tests/live/
```

**Expected:** the first run passes the two hosted Skills Wiki tests (and the resource test when
`SKILLSWIKI_LIVE_RESOURCE=<pack>/<skill>` is exported) and skips the rest; the second also passes
`registers a headers-helper server, has claude -p call get_active_combo, then cleans up` and leaves no
`swtest-installer` server (`claude mcp get swtest-installer` exits 1) and no `skillswiki-live` keychain item.
`npm test` reports `Test Files  29 passed (29)` with no live file.

**Record:**
- Pass / Fail:

---

## Test 9: Clean up

```bash
installer disconnect skillswiki || true
cd ~
rm -rf ~/installer-plan3-test
claude mcp get skillswiki; echo " exit=$?"
```

**Expected:** `exit=1`; nothing was installed outside `~/installer-plan3-test`, and no key remains in the keychain.
