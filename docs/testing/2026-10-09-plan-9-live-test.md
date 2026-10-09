# Plan 9 live test guide (doctor, host readiness, kill switch, pinned packs, support bundle, uninstall)

Use this guide to check Plan 9 by hand on your own Mac. Each test gives the commands to run, what you should see,
and a place to record what you actually saw. If a result differs, collect the items in **Diagnostics to capture** at
the end of the [Plan 1 guide](2026-10-07-plan-1-live-test.md#diagnostics-to-capture).

The **Expected** lines below were rehearsed in a sandbox with the host checks switched off; the host readiness lines
(Test 2) are predictions, because the automated tests never read a real Mac's settings. The first person to run this
guide replaces them with the actual output.

**What this guide changes on your machine:** nothing outside `~/installer-plan9-test`. It makes no `claude` call (the
test solution has no probe step), sends no message (it sets up no channel) and writes nothing to Skills Wiki: Test 1
reads one skill file twice. The keychain is a throwaway folder under the test directory (`INSTALLER_KEYCHAIN=file`),
so `installer uninstall` cannot delete your real keychain items, and `INSTALLER_PROFILE_DIR` points at an empty
folder, so it cannot remove your real Claude Code MCP servers either. Test 2 reads three settings with `pmset -g`,
`systemsetup -getusingnetworktime` and `fdesetup status` (read only); the fixes it prints are for you to read, not to
run, unless this Mac is meant to be a team host.

## What this build can and cannot do

Plan 9 adds: `installer doctor` (health checks with a fix for each finding; it clears run claims a crash left behind,
deletes data past the retention period and tries new Skills Wiki versions in shadow; the runner runs it once a day),
`installer host` (host readiness with printed fixes, the dedicated-user steps, `host service install` for boot
services), `installer pause` and `installer unpause` (the kill switch, also `/pause` and `/unpause` in Telegram),
`installer retention`, `installer packs` (skill files pinned by content, shadow runs, the decision maker's switch),
`installer support bundle` and `installer uninstall`, and the data-flow summary in `installer report`. Not yet: hosted
evals in the shadow upgrade, Windows host checks, the agent in its own OS user (D111).

## Results summary

| Test | What it checks | Pass / Fail | Notes |
|---|---|---|---|
| 0 | Setup: a team-host install with you as the decision maker | | |
| 1 | The automated live read: a skill file's pin is stable | | |
| 2 | Doctor and host readiness on your Mac | | |
| 3 | The kill switch: pause from anywhere, unpause only in your terminal | | |
| 4 | Boot service files, checked but not loaded | | |
| 5 | Retention and the support bundle's redaction | | |
| 6 | Uninstall, then clean up | | |

---

## Test 0: Setup

```bash
export T=~/installer-plan9-test
export REPO=/Users/allenliu/Desktop/ML-Project/installer
export PREFIX=$T/npm
mkdir -p $T $PREFIX $T/keychain $T/no-profiles

node --version            # must be v22 or later
cd $REPO && git log --oneline -1

npm install && npm run build && npm pack --pack-destination $T
npm install -g --prefix $PREFIX $T/installer-0.1.0.tgz
export PATH=$PREFIX/bin:$PATH
export INSTALLER_HOME=$T/home INSTALLER_KEYCHAIN=file INSTALLER_KEYCHAIN_DIR=$T/keychain INSTALLER_PROFILE_DIR=$T/no-profiles
cat > $T/solution.json <<'JSON'
{ "id": "plan9-live", "version": "1.0.0",
  "steps": [
    { "step_id": "mode.shared-work", "phase": "MODE", "type": "ask", "title": "Shared work?", "why": "Mode.", "blocking": true, "input": { "kind": "choice", "options": ["no", "yes", "both"] } },
    { "step_id": "mode.always-on", "phase": "MODE", "type": "ask", "title": "Always on?", "why": "Mode.", "blocking": true, "input": { "kind": "choice", "options": ["no", "yes"] } },
    { "step_id": "mode.decision-maker", "phase": "MODE", "type": "ask", "title": "Decision maker?", "why": "Approvals and alerts.", "blocking": true, "input": { "kind": "text" } },
    { "step_id": "mode.derive", "phase": "MODE", "type": "auto", "title": "Choose the setup", "why": "Mode.", "blocking": true,
      "auto": { "action": "derive_mode", "args": { "shared_work": "mode.shared-work", "always_on": "mode.always-on", "decision_maker": "mode.decision-maker" } } }
  ] }
JSON
installer start --solution file:$T/solution.json
installer submit mode.shared-work --value '"yes"'
installer submit mode.always-on --value '"yes"'
installer submit mode.decision-maker --value '"<your first and last name>"'
installer report
cd $T
```

**Expected:** the last `submit` answers `{"status":"complete"}`. The report starts with
`✅ READY  (4 of 4 steps done) · plan9-live@1.0.0` and ends with `🩺 Doctor     never run: run 'installer doctor'`,
`🖥️ Host       not checked yet: run 'installer host'`, `🔀 Data flow` and one line for support (no channel, source,
model or Skills Wiki is set up, so they are not listed).

**Actual:**

---

## Test 1: The automated live read

Pick one skill file your Skills Wiki serves: `SKILLSWIKI_LIVE_RESOURCE` from the Plan 3 guide plus one path its test
listed, for example `<pack>/<skill>/references/<file>.md`.

```bash
cd $REPO
set -a; . ~/.config/installer-dev/.env; set +a
SKILLSWIKI_LIVE_FILE=<pack>/<skill>/<path> npm run test:live -- tests/live/packs.live.test.ts
cd $T
```

**Expected:** `1 passed`: the file's text, and so its sha256 pin (D107), is the same on two reads. A failure that
names different sha256s means content pinning would see a new version on every check: tell Claude.

**Actual:**

---

## Test 2: Doctor and host readiness on your Mac

```bash
installer doctor
installer host
installer report | tail -4
```

**Expected:** `doctor` exits 0 with `"status"` `ok` or `warn` and checks in this order: `state`, `audit` (`… lines,
hash chain intact`), `pause`, `secrets` (`this install stores no keychain items`), `runner` (`the runner has never
ticked`, a `warn`), `gateway` (`no channel is set up, so no gateway is needed`), `disk` (`… GiB free`), `host`,
`run_claims`, `run_records`, `recent_runs`, `retention`, `hardening`. The `host` check says `readiness N/5` and, for a
laptop, names `no_sleep` (your Mac sleeps after some minutes) and `boot_service`. `installer host` shows each check
with `"status"` `ok`, `fix`, `unknown` or `advice`: `no_sleep` with the fix `sudo pmset -a sleep 0`, `power_on`
(`pmset autorestart`), `time_sync` (probably `unknown`: `systemsetup` needs administrator rights to read it),
`disk_encryption` (`FileVault is on`, if it is), and the `dedicated_user` steps. Do not run the fixes on this laptop.
The report now shows `🩺 Doctor     warn (…)` and `🖥️ Host       readiness N/5`.

**Actual (paste the `host` checks):**

---

## Test 3: The kill switch

```bash
echo | installer pause --reason "live test"
echo | installer unpause; echo "exit $?"
installer tick
installer pause status
installer unpause
grep -c '"event":"engine.unpause_refused"' $INSTALLER_HOME/audit/audit.jsonl
```

**Expected:** the piped `pause` answers `"status":"paused"` with `"by":"agent"` (no terminal on stdin, like an
agent's shell: pausing is allowed from anywhere). The piped `unpause` prints
`{"error":"Unpausing sends real messages and starts runs again: the person runs 'installer unpause' in their own terminal, or the decision maker sends /unpause in Telegram","code":2}`
and `exit 2`. `tick` answers `"status":"paused"` with nothing started. `pause status` shows `"paused":true`. The
`unpause` you type answers `{"status":"unpaused","paused":false,…,"by":"terminal","via":"cli"}`, and `grep` counts `1`.

**Actual:**

---

## Test 4: Boot service files, checked but not loaded

```bash
installer host service install
plutil -lint $INSTALLER_HOME/runtime/service/*.plist
installer host service remove
```

**Expected:** `install` lists two files under `$INSTALLER_HOME/runtime/service/` (`com.installer.gateway.<8
characters>.plist` with `KeepAlive`, `com.installer.tickd.<8 characters>.plist` with `StartInterval` 60, both with
`UserName` set to you) and the commands `installer gateway stop`, then `sudo cp …`, `sudo chown root:wheel …`,
`sudo chmod 644 …` and `sudo launchctl bootstrap system …` for each. Run none of the `sudo` commands. `plutil` says
`OK` for both files. `remove` deletes them and prints `sudo launchctl bootout system/…` and `sudo rm …`.

**Actual:**

---

## Test 5: Retention and the support bundle

```bash
installer retention
echo | installer retention --value 30; echo "exit $?"
installer support bundle
B=$(ls $INSTALLER_HOME/exports/support-*.json)
grep -ci "<your last name>" $B; grep -c "$HOME" $B
less $B
```

**Expected:** `retention` shows `{"retention":{"days":90},…}`; the piped shorter period exits 2 (only your terminal
may shorten it). `support bundle` answers `"status":"written"` with its file and the sections `format`, `created_at`,
`versions`, `state`, `report`, `doctor`, `readiness`, `runs`, `settings`, `counts`, `audit`, `secrets_present`,
`logs`. Both `grep -c` print `0`: your name and your home folder are not in it. In `less`, the step
`mode.decision-maker` has no `value`, and `work_dir` starts with `~`.

**Actual:**

---

## Test 6: Uninstall, then clean up

```bash
echo | installer uninstall; echo "exit $?"
installer uninstall
wc -l $INSTALLER_HOME/exports/audit-*.jsonl
cd ~ && rm -rf $T
```

**Expected:** the piped `uninstall` exits 2. The one you type answers `"status":"uninstalled"`, `"gateway":"not_running"`,
both registrations `false` (the empty profile folder), every keychain item `"none"`, an `audit_export` with
`"chain":"intact"` and its line count (equal to `wc -l`), and the unload commands for the per-user schedule and the
boot services. Nothing was loaded in this test, so run none of them. Then delete the test folder.

**Actual:**

---

## Optional (a team host only)

On a Mac that is meant to run the assistant for a team, follow human task 13 instead: create the dedicated user, run
the fixes `installer host` prints, `installer host service install` and its `sudo` commands, then `installer doctor`
again: the `host` check should say `readiness 5/5`.
