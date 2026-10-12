# Plan 8 live test guide (agentic workflows, dry runs, sandbox, hardening, urgent alerts)

Use this guide to check Plan 8 by hand on your own Mac, with your real Claude Code. Each test gives the commands to
run, what you should see, and a place to record what you actually saw. If a result differs, collect the items in
**Diagnostics to capture** at the end of the [Plan 1 guide](2026-10-07-plan-1-live-test.md#diagnostics-to-capture).

The **Expected** lines below are what the plan predicts; they were not yet produced by running the commands. The
first person to run this guide replaces them with the actual output. A real model chooses the calls of an agentic
workflow, so its exact calls (and the hardening proposal built from them) may differ from the prediction.

**What this guide changes on your machine:** it makes about twenty short `claude -p` calls through your own Claude
Code (your subscription; every tool off: the installer makes each call the model names). It writes only under
`~/installer-plan8-test`. It sends no message (the test solution sets up no channel, so alerts are recorded in the
audit), loads no scheduler entry, and writes nothing to Skills Wiki: the automated test in Test 1 only reads your
learnings with `learning_list`.

## What this build can and cannot do

Plan 8 adds: agentic workflows (the model chooses each call among the tools the workflow names; the installer makes
it through the same approvals), `installer workflow list | suggestions | add`, dry runs (`installer dryrun`, confirmed
by a person with `installer dryrun confirm`), sandbox mode (`installer sandbox`), hardening with a replay check
(`installer harden`), earned autonomy (`installer autonomy`), urgent alerts (`installer alerts`, `K<id>` in
Telegram), approval reminders, outbound rate limits, redacted learnings for Skills Wiki (`installer learnings`), and
the starter's CHANNELS, WORKFLOWS, DRY RUN and ACTIVATE steps. Not covered here: earned autonomy needs 25 approvals
in a row (the automated tests cover it), and sending a learning would write to your real Skills Wiki, so only the
read is tested. Not yet: conversations with the agent from a channel, model-chosen context tools for judges
(Plan 9 or later).

## Results summary

| Test | What it checks | Pass / Fail | Notes |
|---|---|---|---|
| 0 | Setup: an install whose probe found your Claude Code | Pass | Commit 6ae6ecc, Node v22.14.0, Claude Code 2.1.296 |
| 1 | The automated live learning read | Pass | `learning_list` answered (read only) |
| 2 | A workflow from plain words, its dry run, and your confirmation | Pass | Dry run: one `memo.add` would-have; confirm refused without a terminal, accepted with one |
| 3 | Sandbox mode: on from anywhere, off only in your terminal | Pass | Sandbox on by agent, run recorded only, off only by a person |
| 4 | Hardening: five runs, a proposal, the replay check, a new version | Pass | Five runs, proposal `call_1 memo.list`, replay ok 5 of 5, version 2 applied; version 2 runs in sandbox until a new dry run is confirmed |
| 5 | An urgent alert, acknowledged in your terminal | Pass | Urgent alert recorded (no channel), ack refused without a terminal, accepted with one |
| 6 | Clean up | Pass | Test folder deleted |

---

## Test 0: Setup

The solution below probes your Claude Code and asks who the decision maker is.

```bash
export T=~/installer-plan8-test
export REPO=/Users/allenliu/Desktop/ML-Project/installer
export PREFIX=$T/npm
mkdir -p $T $PREFIX

node --version            # must be v22 or later
cd $REPO && git log --oneline -1

npm install && npm run build && npm pack --pack-destination $T
npm install -g --prefix $PREFIX $T/installer-0.1.0.tgz
export PATH=$PREFIX/bin:$PATH
cat > $T/solution.json <<'JSON'
{ "id": "plan8-live", "version": "1.0.0",
  "steps": [
    { "step_id": "preflight.probe", "phase": "PREFLIGHT", "type": "auto", "title": "Check the agent", "why": "Workflows need it.", "blocking": true,
      "auto": { "action": "probe_runtime", "args": { "profile": "claude-code" } } },
    { "step_id": "mode.shared-work", "phase": "MODE", "type": "ask", "title": "Shared work?", "why": "Mode.", "blocking": true, "input": { "kind": "choice", "options": ["no", "yes", "both"] } },
    { "step_id": "mode.always-on", "phase": "MODE", "type": "ask", "title": "Always on?", "why": "Mode.", "blocking": true, "input": { "kind": "choice", "options": ["no", "yes"] } },
    { "step_id": "mode.decision-maker", "phase": "MODE", "type": "ask", "title": "Decision maker?", "why": "Approvals and alerts.", "blocking": true, "input": { "kind": "text" } },
    { "step_id": "mode.derive", "phase": "MODE", "type": "auto", "title": "Choose the setup", "why": "Mode.", "blocking": true,
      "auto": { "action": "derive_mode", "args": { "shared_work": "mode.shared-work", "always_on": "mode.always-on", "decision_maker": "mode.decision-maker" } } }
  ] }
JSON
export INSTALLER_HOME=$T/home
installer start --solution file:$T/solution.json
installer submit mode.shared-work --value '"yes"'
installer submit mode.always-on --value '"no"'
installer submit mode.decision-maker --value '"Owner"'
installer report --json
cd $T
```

**Expected:** the last `submit` answers `{"status":"complete"}`; the report has `"overall":"ready"` or
`"ready_with_limits"` and `"runtime":{"profile":"claude-code",…,"c4_headless":true,…}`.

**Record:**
- Commit shown by `git log`: 6ae6ecc (fix(core): keep one open urgent alert per workflow)
- Pass / Fail: Pass (2026-10-12)

---

## Test 1: The automated live learning read

One `learning_list` call for the pack of your active combo's first skill; nothing is written. Load your own
Skills Wiki variables the way you did for the Plan 3 guide, in this terminal only.

```bash
cd $REPO
set -a; . ~/.config/installer-dev/.env; set +a
npm run test:live -- tests/live/learning.live.test.ts
cd $T
```

**Expected:** `Test Files  1 passed (1)` and `Tests  1 passed (1)` (the test passes when Learning Mode is off, too).

**Record:**
- Pass / Fail: Pass

---

## Test 2: A workflow from plain words, its dry run, and your confirmation

```bash
installer tool memo.add '{"text":"Order more paper"}'
installer workflow add count --value '{"description":"Read the memos with memo.list, then add one memo that says how many memos there are.","tools":["memo.list","memo.add"]}'
installer dryrun count
installer tool memo.list '{}'
installer dryrun confirm count --as Owner < /dev/null
installer dryrun confirm count --as Owner
installer workflow list
```

**Expected:** `add` prints `{"status":"added","workflow":"count","version":1,"mode":"agentic","sandbox":true,…}`.
`dryrun` takes a few seconds per model call and prints `{"dry_runs":[{"workflow":"count",…,"status":"completed",…,
"would_have":[{"id":1,"action":{"tool":"memo.add","args":{"text":"<a sentence with the count>"}},"level":"L1",…}],…}]}`;
`memo.list` still shows only `Order more paper`. The confirm with `< /dev/null` (no terminal, like an agent's shell)
exits 2 with `A dry run is confirmed by the person who read it, in their own terminal …`; the next one prints
`{"status":"confirmed","workflow":"count","version":1,…}`, and `workflow list` shows `"sandbox":false`.

**Record:**
- Pass / Fail: Pass (dry run completed with 2 model calls; `would_have` = `memo.add "There is 1 memo."` at L1; real memos unchanged; confirm without a terminal exit 2; confirmed by Owner)

---

## Test 3: Sandbox mode

```bash
installer sandbox on < /dev/null
installer run count
installer tool memo.list '{}'
installer sandbox off < /dev/null
installer sandbox off --as Owner
installer sandbox status
```

**Expected:** `on` prints `"mode":{"on":true,…,"by":"agent"}`; the run prints `"sandbox":true` and `memo.list` is
unchanged; `off` without a terminal exits 2 with `Leaving sandbox sends real messages again …`; with your terminal it
prints `"status":"off"`; `status` shows `"mode":{"on":false,…}`.

**Record:**
- Pass / Fail: Pass (run `sandbox:true`, memo list unchanged; `off` without a terminal exit 2; off by Owner)

---

## Test 4: Hardening

Five real runs, then the proposal. Each run asks your Claude Code two or three times.

```bash
for i in 1 2 3 4 5; do installer run count | head -c 300; echo; done
installer harden count
installer harden count apply --as Owner < /dev/null
installer harden count apply --as Owner
installer run count
ls $INSTALLER_HOME/workflows/count/versions
```

**Expected:** five runs with `"status":"completed"`. `harden count` prints a proposal whose `promoted` starts with
`{"id":"call_1","tool":"memo.list","args":{}}` and `"agent_kept":true` (the memo's text is the model's own sentence),
and `"replay":{"ok":true,"runs":[…5 runs, each "ok":true…]}`. The apply without a terminal exits 2; with your
terminal it prints `{"status":"hardened","workflow":"count","version":2,"kept":"workflows/count/versions/1",…}`.
The next run completes and its steps start with `call_1` (the promoted fixed call) followed by `agent`; the run answer has no `"version"` field. Version 2 runs in sandbox (`"sandbox":true`) until a person dry-runs and confirms it again, so no real memo is added by that run. `ls` prints `1`.

**Record:**
- The proposal you got (copy `promoted`): `[{"id":"call_1","tool":"memo.list","args":{}}]`, `agent_kept: true`
- Pass / Fail: Pass (promoted `[{"id":"call_1","tool":"memo.list","args":{}}]`, `agent_kept:true`, replay ok for all 5 runs; apply without a terminal exit 2; hardened to version 2, version 1 kept)

---

## Test 5: An urgent alert, acknowledged in your terminal

```bash
mkdir -p $INSTALLER_HOME/workflows/watch
cat > $INSTALLER_HOME/workflows/watch/workflow.json <<'JSON'
{ "workflow": "watch", "version": 1,
  "steps": [ { "id": "look", "judge": { "instructions": "Is this report urgent? Answer urgent true or false, and why.",
      "input": "Water is coming through the ceiling of the meeting room.",
      "schema": { "type": "object", "properties": { "urgent": { "type": "boolean" }, "why": { "type": "string" } }, "required": ["urgent", "why"] } } } ] }
JSON
installer run watch
installer alerts
installer alerts ack 1 --as Owner < /dev/null
installer alerts ack 1 --as Owner
grep -c '"event":"alert' $INSTALLER_HOME/audit/audit.jsonl
```

**Expected:** the run prints `"status":"completed"`; `alerts` lists `{"id":1,"workflow":"watch",…,"sends":1,…}` (no
channel is set up, so the message was not delivered and the audit says so); the ack without a terminal exits 2; with
your terminal it prints `"status":"acknowledged"` with `"acknowledged_by":"Owner"`; `grep` counts 2 (`alert.sent`,
`alert.acknowledged`).

**Record:**
- Pass / Fail: Pass (alert 1 recorded with `sends:1`; ack without a terminal exit 2; acknowledged by Owner; audit count 2)

---

## Test 6: Clean up

```bash
rm -rf $T
```

**Expected:** nothing printed. No scheduler entry, keychain item or Skills Wiki data was created by this guide.

**Record:**
- Pass / Fail: Pass
