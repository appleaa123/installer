# Plan 7 live test guide (workflow runner, judges, the schedule)

Use this guide to check Plan 7 by hand on your own Mac, with your real Claude Code and your real launchd. Each test
gives the commands to run, what you should see, and a place to record what you actually saw. If a result differs,
collect the items in **Diagnostics to capture** at the end of the
[Plan 1 guide](2026-10-07-plan-1-live-test.md#diagnostics-to-capture).

The **Expected** lines below are what the plan predicts; they were not yet produced by running the commands. The
first person to run this guide replaces them with the actual output.

**What this guide changes on your machine:** it makes a few judge calls through your own Claude Code (your
subscription; each is one short `claude -p` call with every tool off), and in Test 4 you load one LaunchAgent,
`com.installer.tick.<8 characters>`, which runs `taskfollow tick` every minute until Test 8 removes it. It sends no
message: the test solution sets up no channel, so the back-online notice and the report are recorded in the audit
and the run log instead. It calls no model API directly and needs no API key.

## What this build can and cannot do

Plan 7 adds: workflow files (`workflows/<id>/workflow.json`) with `tool`, `judge` and `approve` steps, `taskfollow run
<workflow> [--sandbox]`, `taskfollow tick`, `taskfollow schedule list | install | remove | report`, `taskfollow model`,
judges through your agent (or a direct model API when the agent cannot be called headless), a run log under `runs/`,
missed runs and the host-back-online notice, event triggers from the gateway's inbox, the twice-daily report and
escalation to the decision maker. The installer never loads the schedule itself: it writes the file and prints the
commands for you. Not yet: agentic workflows, dry runs, the WORKFLOWS phase in a solution (Plan 8), systemd and
Windows (Plan 9).

## Results summary

| Test | What it checks | Pass / Fail | Notes |
|---|---|---|---|
| 0 | Setup: an install whose probe found your Claude Code | Pass | Commit 1400058, Node v22.14.0, Claude Code 2.1.296 |
| 1 | The automated live judge test | Pass | One real judge call through `claude -p`, 4.6 s |
| 2 | A workflow by hand, and a sandbox run | Pass | Sandbox run also writes the internal memo |
| 3 | A judge step through your Claude Code, and an approve step | Pass | 4 memos labelled (the home already held 2 from Test 2); `context_calls` empty |
| 4 | The schedule: write it, load it yourself, see the runner tick | Pass | LaunchAgent loaded by hand; one tick per minute; macOS showed a Background Items notice |
| 5 | A scheduled run starts on time, once | Pass | One memo and one run, started 35 s after the scheduled minute |
| 6 | Sleep through a scheduled run: missed, not run late, one back-online notice (O14) | Pass on 3rd attempt | Needs the Mac asleep more than 5 minutes past the scheduled minute (tolerance); then `missed`, no late run, one back-online line |
| 7 | The twice-daily report | Pass | Two report runs failed with `No joined member is called 'Owner'` |
| 8 | Remove the schedule and clean up | Pass | Agent unloaded and plist removed; ticks stopped |

---

## Test 0: Setup

The solution below has one step, the probe, with your Claude Code profile; when it is done the install is finished.

```bash
export T=~/installer-plan7-test
export REPO=/Users/allenliu/Desktop/ML-Project/installer
export PREFIX=$T/npm
mkdir -p $T $PREFIX

node --version            # must be v22 or later
cd $REPO && git log --oneline -1

npm install && npm run build && npm pack --pack-destination $T
npm install -g --prefix $PREFIX $T/taskfollow-0.1.0.tgz
export PATH=$PREFIX/bin:$PATH
which taskfollow
cat > $T/solution-runner.json <<'JSON'
{ "id": "plan7-live", "version": "1.0.0",
  "steps": [ { "step_id": "preflight.probe", "phase": "PREFLIGHT", "type": "auto", "title": "Check the agent", "why": "Judges need it.", "blocking": true,
               "auto": { "action": "probe_runtime", "args": { "profile": "claude-code" } } } ] }
JSON
export INSTALLER_HOME=$T/home
taskfollow start --solution file:$T/solution-runner.json
taskfollow report --json
cd $T
```

**Expected:** `which taskfollow` prints `<your home>/installer-plan7-test/npm/bin/taskfollow`; the report has
`"overall":"ready"` or `"ready_with_limits"` and `"runtime":{"profile":"claude-code",…,"c4_headless":true,"c4_schema":true,…}`.

**Record:**
- Commit shown by `git log`: 1400058 (fix(core): skip damaged runs in the report pass)
- Pass / Fail: Pass (2026-10-12)

---

## Test 1: The automated live judge test

One headless call through `claude -p` with a two-label schema; no env file is needed.

```bash
cd $REPO
npm run test:live -- tests/live/judge.live.test.ts
cd $T
```

**Expected:** `Test Files  1 passed (1)` and `Tests  1 passed (1)`.

**Record:**
- Pass / Fail: Pass

---

## Test 2: A workflow by hand, and a sandbox run

```bash
mkdir -p $INSTALLER_HOME/workflows/note
cat > $INSTALLER_HOME/workflows/note/workflow.json <<'JSON'
{ "workflow": "note", "version": 1, "description": "Adds one memo",
  "steps": [ { "id": "add", "tool": "memo.add", "args": { "text": "Run ${run.id}" } } ] }
JSON
taskfollow run note
taskfollow run note --sandbox
taskfollow tool memo.list '{}'
taskfollow run nothing
```

**Expected:** two answers `{"workflow":"note","run_id":"<date>-<8 hex>","status":"completed",…,"actions":1,…}`, the
second with `"sandbox":true`; `memo.list` shows two memos `Run <run id>`; the last command exits 2 with
`No workflow 'nothing': workflows/nothing/workflow.json does not exist in the home`.

**Record:**
- Pass / Fail: Pass (two completed runs, the second with `"sandbox":true`; two memos; `No workflow 'nothing'` exit 2)

---

## Test 3: A judge step through your Claude Code, and an approve step

```bash
taskfollow tool memo.add '{"text":"Call the supplier about the late order"}'
taskfollow tool memo.add '{"text":"Water the office plants next month"}'
mkdir -p $INSTALLER_HOME/workflows/sort
cat > $INSTALLER_HOME/workflows/sort/workflow.json <<'JSON'
{ "workflow": "sort", "version": 1,
  "steps": [
    { "id": "memos", "tool": "memo.list" },
    { "id": "label", "foreach": "${memos.memos}",
      "judge": { "instructions": "Does this memo need action this week? Put now or later in label, and how sure you are (0 to 1) in confidence.",
                 "input": "${item.text}",
                 "schema": { "type": "object", "properties": { "label": { "type": "string", "enum": ["now", "later"] }, "confidence": { "type": "number", "minimum": 0, "maximum": 1 } }, "required": ["label", "confidence"], "additionalProperties": false } } },
    { "id": "fix", "approve": { "tool": "memo.edit", "args": { "id": 1, "text": "Labels: ${label[*].label}" }, "why": "Record the labels on the first memo" } }
  ] }
JSON
taskfollow run sort
taskfollow approvals list
```

**Expected:** `taskfollow run sort` takes up to a minute per memo (one `claude -p` call each) and prints
`"status":"waiting"` with `"steps":[{"step":"memos","status":"done"},{"step":"label","status":"done"},{"step":"fix","status":"waiting","approval":1}]`
and a `next` line; `approvals list` shows item 1 for `memo.edit` with the why above and `"source":{"via":"runner","run":{"workflow":"sort",…,"step":"fix"}}`.
Your home may already hold memos from Test 2, so the judge labels every memo it finds (four after Test 2: four `claude -p` calls). Look at the labels: `cat $INSTALLER_HOME/runs/sort/*/steps/label.json` shows an `output` like
`[{"label":"now",…},{"label":"later",…}]` and `"context_calls":[]`.

Now decide it yourself and let the runner continue:

```bash
taskfollow approvals approve 1
taskfollow tick
taskfollow tool memo.list '{}'
```

**Expected:** `tick` prints `"resumed":["sort <run id> (completed)"]`; memo 1 now reads `Labels: ["now","later"]` (or
whatever labels your agent chose).

**Record:**
- Labels chosen: later, later, now, later (confidence 0.85, 0.85, 0.75, 0.95)
- Pass / Fail: Pass (`tick` resumed the run; memo 1 became the labels)

---

## Test 4: The schedule

```bash
taskfollow schedule list
taskfollow schedule install
```

**Expected:** `list` shows `"last_tick"` as `null` before any `taskfollow tick` has run (after Test 3's manual tick it already shows that tick's time). `install` prints
`{"backend":"launchd","label":"com.installer.tick.<8 hex>","file":"<home>/runtime/schedule/com.installer.tick.<8 hex>.plist","commands":["mkdir -p ~/Library/LaunchAgents","cp '…plist' ~/Library/LaunchAgents/com.installer.tick.<8 hex>.plist","launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.installer.tick.<8 hex>.plist"],…}`.

Check the file, then run the three printed commands yourself, exactly as printed (macOS shows a "Background Items Added" notice and lists the item under System Settings → General → Login Items & Extensions; keep it switched on). launchd starts jobs with a minimal `PATH`, so a scheduled workflow that calls a judge needs `claude` on that path; these test workflows only add memos:

```bash
plutil -lint $INSTALLER_HOME/runtime/schedule/com.installer.tick.*.plist
# now paste and run the three commands from "commands"
sleep 130
taskfollow schedule list
tail -3 $INSTALLER_HOME/runtime/schedule/tick.log
```

**Expected:** `plutil` prints `… OK`; after two minutes `list` shows a `last_tick` from the last minute, and
`tick.log` has one JSON line per minute such as `{"status":"ran","started":[],"missed":[],…}`.

**Record:**
- Label: com.installer.tick.49e0f952
- Pass / Fail:

---

## Test 5: A scheduled run starts on time, once

Pick a minute three minutes from now in your own time zone (for example 14:23) and put it in the cron line below as
`<minute> <hour>`; set `tz` to your zone (macOS: `sudo systemsetup -gettimezone`, or the zone shown in System
Settings → General → Date & Time).

```bash
mkdir -p $INSTALLER_HOME/workflows/clock
cat > $INSTALLER_HOME/workflows/clock/workflow.json <<'JSON'
{ "workflow": "clock", "version": 1, "trigger": { "cron": "<minute> <hour> * * *", "tz": "<your zone>" },
  "steps": [ { "id": "add", "tool": "memo.add", "args": { "text": "Scheduled for ${run.scheduled_for}" } } ] }
JSON
taskfollow schedule list
sleep 300
taskfollow tool memo.list '{}'
ls $INSTALLER_HOME/runs/clock
```

**Expected:** `list` shows `clock` with `"next"` at your chosen minute (in UTC); after five minutes there is exactly
one memo `Scheduled for <that minute in UTC>` and one run folder.

**Record:**
- Pass / Fail: Pass (one memo `Scheduled for …18:14:00.000Z` created at 18:14:35; one run folder)

---

## Test 6: Sleep through a scheduled run (O14)

Change the `clock` workflow to a minute five minutes from now, put the Mac to sleep two minutes before it (close the
lid, or Apple menu → Sleep), and wake it at least ten minutes after it. A run that starts within 5 minutes of its scheduled minute (`tolerance_minutes`) still counts as on time, so waking sooner than that shows a normal `completed` run and tests nothing. Then, within a minute of waking:

```bash
sleep 70
ls $INSTALLER_HOME/runs/clock
cat $INSTALLER_HOME/runs/clock/*/run.json | grep -c '"status": "missed"'
grep -c 'runner.back_online' $INSTALLER_HOME/audit/audit.jsonl
tail -3 $INSTALLER_HOME/runtime/schedule/tick.log
```

**Expected:** a second run folder whose `run.json` has `"status": "missed"` (the grep counts 1); no new memo for that
minute (the run was not run late); one `runner.back_online` line in the audit; and in `tick.log` the first line after
waking has `"back_online":true` and the missed run (the notice itself goes nowhere: this home has no channel or
decision maker). Note whether launchd ran the tick at once on waking or only at the next interval. (Observed: within seconds on a short sleep, and 15 to 35 seconds after a full wake on a long one.)

**Record:**
- When launchd fired after waking: about 15 to 35 seconds after a full wake (first tick 14:55:20, wake 14:54:45 / full wake 14:55:03)
- Pass / Fail: Pass on the third attempt (see above); a first short sleep ended within the 5-minute tolerance and ran normally; the second was missed because the sleep was started late

---

## Test 7: The twice-daily report

Set the report times to the next two minutes so you do not have to wait for 09:00 (for example `"times":["14:41","14:42"]`
when it is 14:39), in your zone:

```bash
taskfollow schedule report --value '{"recipients":[{"member":"Owner","tz":"<your zone>"}],"times":["<HH:MM>","<HH:MM>"]}'
sleep 200
ls $INSTALLER_HOME/runs/_report
cat $INSTALLER_HOME/runs/_report/*/run.json | grep '"status"'
```

**Expected:** two report runs; both `"status": "failed"` with a reason `No joined member is called 'Owner' …`, because
this home has no channel and no members: the report was composed and handed to `channel.notify`, which had nobody to
send it to. (With Plan 6's Telegram setup and a joined member called Owner, it arrives in Telegram once the install is
finished.)

**Record:**
- Pass / Fail: Pass (both reports `failed`: `No joined member is called 'Owner'; joined: nobody yet (taskfollow invite)`)

---

## Test 8: Remove the schedule and clean up

```bash
taskfollow schedule remove
# run the two printed commands yourself
launchctl list | grep com.installer.tick
rm -rf $T
```

**Expected:** `remove` prints `{"backend":"launchd","label":"com.installer.tick.<8 hex>","commands":["launchctl bootout gui/$(id -u)/com.installer.tick.<8 hex>","rm ~/Library/LaunchAgents/com.installer.tick.<8 hex>.plist"],…}`;
after you run them, `launchctl list | grep com.installer.tick` prints nothing.

**Record:**
- Pass / Fail: Pass (`launchctl bootout` and `rm` run by hand; nothing loaded afterwards; running them twice only gave `No such process`)
