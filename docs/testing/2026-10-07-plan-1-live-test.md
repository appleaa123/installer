# Plan 1 live test guide (engine core)

Use this guide to install the `installer` CLI on your own machine and check each behaviour by hand.
Each test gives the commands to run, what you should see, and a place to record what you actually saw.
If a result differs, the **Diagnostics to capture** section lists what to collect.

Every expected output below was produced by running these exact commands against the packed CLI
on 2026-10-07 (branch `feat/engine-core`, commit `00363ee`, Node 22.14.0, npm 11.12.1, macOS).

## What this build can and cannot do

Plan 1 is the engine core only. It can run a solution written as a local JSON file, with two actions
(`noop`, `write_file`) and one check (`file_exists`). It cannot yet install a real Skills Wiki solution:
there is no `INSTALL.md`, no `skillswiki:` references, no browser page for secrets and no real connectors.
These tests prove the step protocol, input checks, retries, crash recovery, the report and the audit trail.

## Results summary

Fill this in as you go.

| Test | What it checks | Pass / Fail | Notes |
|---|---|---|---|
| 0 | Setup and install | Pass | Run 2026-10-08 on commit `e5da2e2` (guide-only change after `00363ee`) |
| 1 | Full install to READY | Pass | All outputs matched |
| 2 | Repeating commands changes nothing | Pass | State byte-identical; audit ends at 9 lines |
| 3 | Answers, wrong answers and retries | Pass | All 3c rows matched; heredoc paste issue fixed after the run |
| 4 | Optional step given up, then reopened | Pass | All outputs matched |
| 5 | Secrets are refused | Pass | Exit 2; value stored nowhere |
| 6 | Crash in the middle of a step | Pass | Both crashes recovered; temp file cleaned up |
| 7 | Corrupt state file and backup restore | Pass | Exit 3, backup restore worked |
| 8 | Damaged audit file | Pass | Exit 3, file untouched, restore worked |
| 9 | Audit chain verification | Pass | All 4 chains ok; tamper detected at line 2 |
| 10 | Moved or changed solution file | Pass | Runs from its own copy; changed content refused |
| 11 | Empty home path | Pass | Fell back to `$HOME/.installer`; cwd stayed empty |
| 12 | Usage errors | Pass | Confusing `--force` hint fixed in `ef870af` (see notes) |
| 13 | Clean up | Pass | Test folder removed; no tarball in the repo; `~/.installer` never created |

---

## Test 0: Setup and install

All tests run inside one throwaway folder, so nothing touches your real `~/.installer`.
The CLI is installed into that folder too, not into your global npm.

```bash
export T=~/installer-live-test
export REPO=/Users/allenliu/Desktop/ML-Project/installer
export F=$REPO/tests/fixtures/solution-basic.json
export PREFIX=$T/npm
mkdir -p $T $PREFIX

node --version            # must be v22 or later
npm --version
cd $REPO && git log --oneline -1

npm install && npm run build && npm pack --pack-destination $T
npm install -g --prefix $PREFIX $T/installer-0.1.0.tgz
export PATH=$PREFIX/bin:$PATH
which installer
cd $T
```

If you open a new terminal later, run the `export` lines again (including the `PATH` one) and `cd $T`.

**Expected:** Node is v22 or later. `npm pack` prints `installer-0.1.0.tgz`. `which installer` prints `<your home>/installer-live-test/npm/bin/installer`.

**Record:**
- Node version: v22.14.0
- npm version: 11.12.1
- Commit shown by `git log`: `e5da2e2 (HEAD -> feat/engine-core) docs(test): add Plan 1 live test guide`
- `which installer` printed: `/Users/allenliu/installer-live-test/npm/bin/installer`
- Pass / Fail: Pass. `npm pack` produced `installer-0.1.0.tgz` (14 files, 11.6 kB).

---

## Test 1: Full install to READY

Walks the 7-step fixture solution from start to finish, including one failed check.

```bash
installer --home $T/h1 start --solution file:$F
installer --home $T/h1 next
installer --home $T/h1 submit mode.shared-work --value '"yes"'
installer --home $T/h1 submit mode.report-time --value '"09:00"'
installer --home $T/h1 verify brain.register
installer --home $T/h1 report
echo ok > $T/h1/config/agent-marker.txt
installer --home $T/h1 verify brain.register
echo ok > $T/h1/config/extra-channel.txt
installer --home $T/h1 verify channels.optional-extra
installer --home $T/h1 report
installer --home $T/h1 report --json
ls -l $T/h1
ls $T/h1/state $T/h1/config $T/h1/solution
```

**Expected:**
- `start` and `next` both print a step whose `step_id` is `mode.shared-work`. The two engine steps before it already ran by themselves.
- Each `submit` moves on: the first shows `mode.report-time`, the second shows `brain.register`.
- The first `verify brain.register` prints `"status":"failed","hint":"config/agent-marker.txt not found","retry":true`.
- The first `report` prints:
  ```
  ⏳ IN PROGRESS  (4 of 7 steps done) · fixture-basic@1.0.0
  ✅ Working    Write base config · Check base config · Is there shared work? · Morning report time
  ⛔ Needs you 1. Register the skills server — config/agent-marker.txt not found (failed 1 of 3 tries) → then run 'installer verify brain.register'
  ```
- The second `verify brain.register` prints `"status":"passed"`, and the last verify prints `{"status":"passed","next":{"status":"complete"}}`.
- The final `report` starts with `✅ READY  (7 of 7 steps done) · fixture-basic@1.0.0`, and `--json` starts with `{"overall":"ready",...,"done":7,"total":7`.
- `ls -l` shows `audit`, `config`, `solution` and `state`, each with `drwx------` (owner only).
- `state` holds `install-state.json` and `install-state.json.bak`; `config` holds 4 files; `solution` holds `solution.json`.

**Record:**
- First report: `⏳ IN PROGRESS  (4 of 7 steps done) · fixture-basic@1.0.0`, one `⛔ Needs you` line for `brain.register` (failed 1 of 3 tries), as expected
- Final report: `✅ READY  (7 of 7 steps done) · fixture-basic@1.0.0`; `--json` gave `"overall":"ready"`, `"done":7,"total":7`
- Folder permissions: `audit`, `config`, `solution`, `state` all `drwx------`; `state` has `install-state.json` and `.bak`, `config` has 4 files, `solution` has `solution.json`
- Pass / Fail: Pass

---

## Test 2: Repeating commands changes nothing

```bash
cp $T/h1/state/install-state.json $T/before.json
wc -l < $T/h1/audit/audit.jsonl
installer --home $T/h1 next
installer --home $T/h1 resume
installer --home $T/h1 start --solution file:$F
cmp $T/h1/state/install-state.json $T/before.json && echo SAME-STATE
wc -l < $T/h1/audit/audit.jsonl
```

**Expected:** all three commands print `{"status":"complete"}`. `cmp` prints `SAME-STATE`. Both line counts are `9`.

**Record:**
- Audit lines before / after: the paste showed only the final count, `9`. No audit line was added: the state stores the audit head and stayed byte-identical (`SAME-STATE`)
- Pass / Fail: Pass. All three commands printed `{"status":"complete"}`

---

## Test 3: Answers, wrong answers and retries

These tests use a second solution file, `tests/fixtures/live-retry.json`: a check that fails until you fix it,
a text question, a number question and a manual step.

**3a. A failing check, three tries, then blocked:**

```bash
installer --home $T/h2 start --solution file:$REPO/tests/fixtures/live-retry.json
installer --home $T/h2 report
installer --home $T/h2 resume
installer --home $T/h2 resume
installer --home $T/h2 resume
installer --home $T/h2 report
installer --home $T/h2 next
```

**Expected:**
- `start` prints step `pre.check` with `"status":"failed","attempts":1` and `"resume":"installer resume"`.
- The first `report` says `⛔ Needs you 1. Check the marker file — config/late-marker.txt not found (failed 1 of 3 tries) → then run 'installer resume'`.
- The first `resume` tries again: `"status":"failed","attempts":2`.
- The second `resume` reaches the limit: the output starts with `{"status":"blocked"` and shows `"attempts":3`.
- The third `resume` resets the blocked step and tries once more: `"status":"failed","attempts":1`.
- The next `report` again says `failed 1 of 3 tries`.
- `next` prints the same failed step and does not try again on its own.

**3b. Fix the problem and continue:**

```bash
mkdir -p $T/h2/config && echo ok > $T/h2/config/late-marker.txt
installer --home $T/h2 resume
```

**Expected:** the check passes and the output shows the next step, `mode.name`.

**3c. Wrong and right answers.** Run these one at a time and note each exit code with `echo $?`:

```bash
installer --home $T/h2 submit mode.name --value yes
installer --home $T/h2 submit mode.size --value '"ten"'
installer --home $T/h2 submit mode.name --done
installer --home $T/h2 submit no.such.step --done
installer --home $T/h2 submit mode.name --value '"North team"'
installer --home $T/h2 submit mode.size --value=-3
installer --home $T/h2 submit channels.manual --value '"x"'
installer --home $T/h2 submit channels.manual --done
installer --home $T/h2 report
```

**Expected:**

| Command | Output | Exit |
|---|---|---|
| `mode.name --value yes` | `{"error":"--value must be JSON, for text use quotes: --value '\"yes\"'","code":2}` | 2 |
| `mode.size --value '"ten"'` | `Step 'mode.size' is not the current step; current step is 'mode.name'` | 2 |
| `mode.name --done` | `Step 'mode.name' needs an answer: use --value` | 2 |
| `no.such.step --done` | `Unknown step 'no.such.step'` | 2 |
| `mode.name --value '"North team"'` | next step `mode.size` | 0 |
| `mode.size --value=-3` | next step `channels.manual` (a negative number needs the `=` form) | 0 |
| `channels.manual --value '"x"'` | `Step 'channels.manual' takes no value: use --done` | 2 |
| `channels.manual --done` | `{"status":"complete"}` | 0 |

The final `report` starts with `✅ READY  (5 of 5 steps done) · live-retry@1.0.0`.

**Record:**
- 3a attempts seen (1, 2, 3, then 1): 1, 2, 3 (`"status":"blocked"`), then 1. Both reports said `failed 1 of 3 tries`; `next` showed the same failed step at `"attempts":1` without retrying
- 3b result: check passed, next step `mode.name`
- Note: pasting the `cat <<'EOF'` block into zsh left the shell at a `heredoc>` prompt (the closing `EOF` line did not match after pasting). Ctrl+C cancels it safely; `retry.json` was then written to `$T` directly. Fixed after this run: the solution now ships as `tests/fixtures/live-retry.json`
- 3c rows that differed: none. Exit codes 2, 2, 2, 2, 0, 0, 2, 0; final report `✅ READY  (5 of 5 steps done) · live-retry@1.0.0`
- Pass / Fail: Pass

---

## Test 4: Optional step given up, then reopened

```bash
installer --home $T/h3 start --solution file:$F
installer --home $T/h3 submit mode.shared-work --value '"yes"'
installer --home $T/h3 submit mode.report-time --value '"09:00"'
echo ok > $T/h3/config/agent-marker.txt
installer --home $T/h3 verify brain.register
installer --home $T/h3 verify channels.optional-extra
installer --home $T/h3 verify channels.optional-extra
installer --home $T/h3 verify channels.optional-extra
installer --home $T/h3 report
installer --home $T/h3 resume
installer --home $T/h3 report
```

**Expected:**
- The first two optional verifies print `"status":"failed","hint":"Extra channel not connected yet","retry":true`.
- The third prints `{"status":"blocked","hint":"Extra channel not connected yet","retry":false,"next":{"status":"complete"}}`. The step is optional, so the install still completes.
- The first `report`:
  ```
  ⚠️ READY WITH LIMITS  (6 of 7 steps done) · fixture-basic@1.0.0
  ✅ Working    Write base config · Check base config · Is there shared work? · Morning report time · Register the skills server · Write final marker
  ⚠️ Limited   Connect an optional extra channel — Extra channel not connected yet
  ```
- `resume` reopens the optional step, and the second report starts with `⏳ IN PROGRESS  (6 of 7 steps done)` and lists the step under `⛔ Needs you`. This is intended: resume is how you retry an optional step.

**Record:**
- Report after giving up: `⚠️ READY WITH LIMITS  (6 of 7 steps done) · fixture-basic@1.0.0`, optional channel under `⚠️ Limited`
- Report after resume: `⏳ IN PROGRESS  (6 of 7 steps done)`, `⛔ Needs you 1. Connect an optional extra channel — Create the file config/extra-channel.txt`; `resume` reset the step to `"status":"pending","attempts":0`
- Pass / Fail: Pass

---

## Test 5: Secrets are refused

This uses `tests/fixtures/live-secret.json`, a solution with one secret question.

```bash
installer --home $T/h4 start --solution file:$REPO/tests/fixtures/live-secret.json
installer --home $T/h4 submit brain.key --value '"abc123"'
echo $?
grep -c abc123 $T/h4/state/install-state.json $T/h4/audit/audit.jsonl
```

**Expected:** `submit` prints `{"error":"'secret' values are never accepted through submit; they are collected by the local browser page","code":2}` and exits `2`. `grep` shows `0` for both files: the value was never stored.

**Record:**
- Error shown: `{"error":"'secret' values are never accepted through submit; they are collected by the local browser page","code":2}`, exit `2`
- grep counts: `install-state.json:0`, `audit.jsonl:0`
- Pass / Fail: Pass (`secret.json` was written to `$T` directly to avoid the heredoc paste issue; it now ships as `tests/fixtures/live-secret.json`)

---

## Test 6: Crash in the middle of a step

The CLI has a test hook, `INSTALLER_CRASH_AT`, that kills the process at a named point. This is the
same as pulling the plug at the worst moment.

```bash
INSTALLER_CRASH_AT=engine:after-action installer --home $T/h5 start --solution file:$F
echo $?
ls $T/h5/state
installer --home $T/h5 resume

INSTALLER_CRASH_AT=state:before-rename installer --home $T/h5 submit mode.shared-work --value '"yes"'
echo $?
ls $T/h5/state
installer --home $T/h5 next
installer --home $T/h5 submit mode.shared-work --value '"yes"'
ls $T/h5/state
```

**Expected:**
- The first command is killed: zsh prints `zsh: killed ...` (bash prints `Killed: 9`), and `echo $?` prints `137`.
- `ls` shows `install-state.json`. `resume` then finishes the interrupted work and prints step `mode.shared-work`.
- The second crash is also killed with `137`. `ls` now shows `install-state.json`, `install-state.json.<number>.tmp` and `install-state.json.bak`. The temp file is the half-finished save.
- `next` shows `mode.shared-work` again: the answer was not saved, so you answer it again.
- The repeat `submit` succeeds and shows `mode.report-time`.
- The last `ls` shows only `install-state.json` and `install-state.json.bak`: the leftover temp file was cleaned up.

**Record:**
- Exit codes: `137` and `137` (zsh printed `zsh: killed ...` both times); `resume` after the first crash showed `mode.shared-work`
- `ls` after the second crash: `install-state.json  install-state.json.86475.tmp  install-state.json.bak`; `next` still showed `mode.shared-work`, repeat `submit` showed `mode.report-time`
- `ls` at the end: `install-state.json  install-state.json.bak`
- Pass / Fail: Pass

---

## Test 7: Corrupt state file and backup restore

```bash
cp $T/h1/state/install-state.json $T/good-state.json
echo "{ broken" > $T/h1/state/install-state.json
installer --home $T/h1 report
echo $?
cp $T/h1/state/install-state.json.bak $T/h1/state/install-state.json
installer --home $T/h1 report
installer --home $T/h1 next
installer --home $T/h1 report
```

**Expected:**
- The first `report` exits `3` with `{"error":"<path>/install-state.json is not valid JSON; it was not changed. Restore it or start in a new home. A backup of the previous state is at <path>/install-state.json.bak; copy it over the state file to continue.","code":3}`.
- The CLI never overwrites the broken file itself.
- After copying the backup in, `report` shows `⏳ IN PROGRESS  (6 of 7 steps done)`. The backup is one step behind.
- `next` redoes that last step and prints `{"status":"complete"}`. The last `report` shows `✅ READY  (7 of 7 steps done)`.

**Record:**
- Error and exit code: `{"error":"<home>/state/install-state.json is not valid JSON; it was not changed. Restore it or start in a new home. A backup of the previous state is at <home>/state/install-state.json.bak; copy it over the state file to continue.","code":3}`, exit `3`
- Report after restore: `⏳ IN PROGRESS  (6 of 7 steps done)`; `Write final marker` (an auto step) not yet listed
- Report after `next`: `next` printed `{"status":"complete"}`, report `✅ READY  (7 of 7 steps done)`
- Pass / Fail: Pass

---

## Test 8: Damaged audit file

A damaged audit line is only noticed when a command writes. This test uses a fresh install that is
still in progress.

```bash
installer --home $T/h6 start --solution file:$F
cp $T/h6/audit/audit.jsonl $T/good-audit.jsonl
printf '{"seq":' >> $T/h6/audit/audit.jsonl
md5 -q $T/h6/audit/audit.jsonl
installer --home $T/h6 submit mode.shared-work --value '"yes"'
echo $?
md5 -q $T/h6/audit/audit.jsonl
installer --home $T/h6 report
cp $T/good-audit.jsonl $T/h6/audit/audit.jsonl
installer --home $T/h6 submit mode.shared-work --value '"yes"'
```

**Expected:**
- `submit` exits `3` with `{"error":"<path>/audit/audit.jsonl has a damaged last line; it was not changed. Restore it from a copy, or start in a new home.","code":3}`.
- Both `md5` values are identical: the file was not touched.
- `report` still works (it only reads), showing `⏳ IN PROGRESS  (2 of 7 steps done)`.
- After restoring the good copy, `submit` succeeds and shows `mode.report-time`.

**Record:**
- Error and exit code: `{"error":"<home>/audit/audit.jsonl has a damaged last line; it was not changed. Restore it from a copy, or start in a new home.","code":3}`, exit `3`
- md5 before / after: `7c6e071103188d04ac0fda60e8c95448` / `7c6e071103188d04ac0fda60e8c95448` (identical). `report` showed `⏳ IN PROGRESS  (2 of 7 steps done)`; after restoring the copy, `submit` showed `mode.report-time`
- Pass / Fail: Pass

---

## Test 9: Audit chain verification

There is no `installer doctor` yet (Plan 9), so this calls the verifier in the installed package directly:

```bash
node --input-type=module -e "
import { verifyAudit } from '$PREFIX/lib/node_modules/installer/dist/core/audit.js';
import { loadState } from '$PREFIX/lib/node_modules/installer/dist/core/state.js';
const home = process.argv[1];
const state = await loadState(home);
console.log(JSON.stringify(await verifyAudit(home, state?.audit_head)));
" $T/h2
```

**Expected:** `{"ok":true,"lines":<count>}`. Run it for `$T/h1`, `$T/h3` and `$T/h5` as well; each should print `"ok":true`.

To see tamper detection, change one character inside any line of `$T/h2/audit/audit.jsonl` with a text editor
(for example a letter in a `ts` value) and run the command again. **Expected:** `{"ok":false,"line":<n>,"reason":"hash mismatch"}`.

**Record:**
- Results per home: `h1` `{"ok":true,"lines":10}` (9 from Test 2 plus the redo in Test 7), `h2` `{"ok":true,"lines":14}`, `h3` `{"ok":true,"lines":11}`, `h5` `{"ok":true,"lines":5}`
- Result after tampering: `{"ok":false,"line":2,"reason":"hash mismatch"}`. Tampered with `sed -i '' '2s/"ts":"2026/"ts":"2025/' $T/h2/audit/audit.jsonl` instead of an editor (original kept at `$T/h2-audit-backup.jsonl`)
- Pass / Fail: Pass

---

## Test 10: Moved or changed solution file

```bash
cp $F $T/sol.json
installer --home $T/h8 start --solution file:$T/sol.json
mv $T/sol.json $T/sol-moved.json
installer --home $T/h8 report
cp $T/sol-moved.json $T/sol-copy.json
installer --home $T/h8 start --solution file:$T/sol-copy.json
sed 's/Write base config/Write the base config/' $T/sol-moved.json > $T/sol-changed.json
installer --home $T/h8 start --solution file:$T/sol-changed.json
echo $?
```

**Expected:**
- `report` still works after the source file is moved: `⏳ IN PROGRESS  (2 of 7 steps done)`. The install runs from its own copy in `$T/h8/solution/solution.json`.
- `start` with an identical copy at another path succeeds and shows `mode.shared-work`.
- `start` with changed content exits `2` with `This home already has an install of 'fixture-basic@1.0.0' with different solution content; use a different --home`.

**Record:**
- Report after the move: `⏳ IN PROGRESS  (2 of 7 steps done) · fixture-basic@1.0.0`; `start` with the identical copy showed `mode.shared-work`
- Changed-content error: `{"error":"This home already has an install of 'fixture-basic@1.0.0' with different solution content; use a different --home","code":2}`, exit `2`
- Pass / Fail: Pass

---

## Test 11: Empty home path

An empty `--home` (or an empty `INSTALLER_HOME`) must fall back to `~/.installer`, never the current folder.
This test points `HOME` at a fake folder so your real home is not touched.

```bash
mkdir -p $T/fakehome $T/emptycwd
cd $T/emptycwd
HOME=$T/fakehome installer --home "" start --solution file:$F
ls -A $T/emptycwd
ls $T/fakehome/.installer
HOME=$T/fakehome INSTALLER_HOME="" installer next
cd $T
```

**Expected:** `start` succeeds. `ls -A $T/emptycwd` prints nothing: the current folder stays empty.
`ls $T/fakehome/.installer` shows `audit config solution state`. The last command finds the same install and shows `mode.shared-work`.

**Record:**
- Contents of `emptycwd`: empty (`ls -A` printed nothing)
- Contents of `fakehome/.installer`: `audit  config  solution  state`; `INSTALLER_HOME=""` found the same install at `mode.shared-work`
- Pass / Fail: Pass

---

## Test 12: Usage errors

```bash
installer --home $T/h10 next
installer --home $T/h10 bogus
installer --home $T/h1 next --force
ls $T/h10
```

**Expected:**
- `{"error":"No install found in this home; run 'installer start --solution <ref>' first","code":2}`.
- `{"error":"Unknown command 'bogus'. Commands: start, next, submit, verify, resume, report","code":2}`.
- `{"error":"Unknown option '--force'. Options: --home, --solution, --value, --done, --json","code":2}` (since `ef870af`; before that, Node's own message).
- `ls $T/h10` fails with `No such file or directory`: a failed command creates nothing.

**Record:**
- Outputs that differed: none; all three exited `2` and `ls $T/h10` failed with `No such file or directory`. The full `--force` message is Node's `parseArgs` text: `Unknown option '--force'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- "--force"`. The hint about `--` does not apply to this CLI and may confuse users (minor, cosmetic). Fixed in `ef870af`: the CLI now lists its valid options instead
- Pass / Fail: Pass

---

## Test 13: Clean up

```bash
rm -rf ~/installer-live-test
rm -f $REPO/installer-0.1.0.tgz
```

Nothing was installed outside `~/installer-live-test`, so this removes everything.

---

## Diagnostics to capture

When a result differs from the expected one, collect the following for that home (replace `hN`) and
paste it under the test's **Record**. None of these files hold secrets.

```bash
H=$T/hN
echo "exit code of the last command: $?"     # run this immediately after the failing command
installer --home $H report --json
cat $H/state/install-state.json
ls -la $H $H/state $H/audit $H/config $H/solution
tail -5 $H/audit/audit.jsonl
node --version; which installer
```

Also note:
- The exact command you ran, copied from the terminal.
- The full output, including any line on stderr (errors are one JSON line with `error` and `code`).
- Whether you had changed any file in the home by hand before the failure.

Exit codes: `0` OK · `1` internal error (always a bug: report it) · `2` usage, input or rule error · `3` corrupt state or audit file.
