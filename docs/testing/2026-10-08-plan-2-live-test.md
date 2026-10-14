# Plan 2 live test guide (runtime conformance)

Use this guide to install the `installer` CLI on your own machine and check Plan 2 by hand, against your real Claude Code.
Each test gives the commands to run, what you should see, and a place to record what you actually saw.
If a result differs, collect the items in **Diagnostics to capture** at the end of the
[Plan 1 guide](2026-10-07-plan-1-live-test.md#diagnostics-to-capture).

Every expected output below was produced by running these exact commands against the packed CLI
on 2026-10-08 (branch `feat/runtime-conformance`, Claude Code 2.1.294, Node 22.14.0, macOS), except where a test says otherwise.

## What this build can and cannot do

Plan 2 adds: `taskfollow probe` (does your agent support headless calls, structured output and session resume),
`https:` solution links, the three MODE questions (personal, team host or hybrid, and the decision maker),
per-agent hints, `INSTALL.md` and a starter solution. It still needs no key or password.
It cannot yet connect Skills Wiki, enter keys, or install a `skillswiki:` solution: that is Plan 3.

`taskfollow probe` makes four very small calls to your agent (Claude Code `-p`), so it uses a little of your own plan or credit.

## Results summary

| Test | What it checks | Pass / Fail | Notes |
|---|---|---|---|
| 0 | Setup and install | Pass | Commit 4a0c818, Node v22.14.0 |
| 1 | Probe your real Claude Code | Pass | Agent 2.1.296 (guide: 2.1.294) |
| 2 | Starter install end to end | Pass | Matches Expected; agent 2.1.296 |
| 3 | `http:` and failing `https:` links | Pass | Terminal had no DNS: online `answered HTTP <status>` branch not exercised |
| 4 | No known agent | Pass | Identical to Expected |
| 5 | Clean up | Pass | Folder removed |

---

## Test 0: Setup and install

```bash
export T=~/installer-plan2-test
export REPO=/Users/allenliu/Desktop/ML-Project/installer
export PREFIX=$T/npm
mkdir -p $T $PREFIX

node --version            # must be v22 or later
cd $REPO && git log --oneline -1

npm install && npm run build && npm pack --pack-destination $T
npm install -g --prefix $PREFIX $T/taskfollow-0.1.0.tgz
export PATH=$PREFIX/bin:$PATH
which taskfollow
cd $T
```

**Expected:** `which taskfollow` prints `<your home>/installer-plan2-test/npm/bin/taskfollow`.

**Record:**
- Commit shown by `git log`: 4a0c818 (fix(core): refuse MODE questions derive_mode cannot use)
- `which taskfollow` printed: /Users/allenliu/installer-plan2-test/npm/bin/taskfollow
- Pass / Fail: Pass (2026-10-12; Node v22.14.0)

---

## Test 1: Probe your real Claude Code

```bash
taskfollow probe
echo $?
```

**Expected** (takes 10–30 seconds):

```
{"profile":"claude-code","agent_version":"2.1.294","c2_shell":true,"c4_headless":true,"c4_schema":true,"c5_resume":true,"c6_mcp":"not_probed","support_level":2,"tier":"compatible","notes":[]}
0
```

Your `agent_version` may be newer. `support_level` is 2 of 3 because the MCP check (C6) comes with Plan 3.

**Record:**
- Output: `{"profile":"claude-code","agent_version":"2.1.296","c2_shell":true,"c4_headless":true,"c4_schema":true,"c5_resume":true,"c6_mcp":"not_probed","support_level":2,"tier":"compatible","notes":[]}`, exit 0
- Pass / Fail: Pass

---

## Test 2: Starter install end to end

```bash
installer --home $T/h1 start --solution file:$REPO/solutions/starter.json
installer --home $T/h1 submit mode.shared-work --value '"yes"'
installer --home $T/h1 submit mode.always-on --value '"no"'
installer --home $T/h1 submit mode.decision-maker --value '"Owner"'
installer --home $T/h1 report
node -e 'const s=require(process.argv[1]);console.log(JSON.stringify(s.mode),JSON.stringify(s.roles))' $T/h1/state/install-state.json
```

**Expected:**
- `start` probes the agent first (10–30 seconds), then shows step `mode.shared-work`.
- The submits show `mode.always-on`, then `mode.decision-maker`, then `{"status":"complete"}`.
- The report:
  ```
  ✅ READY  (6 of 6 steps done) · starter@1.0.0
  ✅ Working    Check what your agent can do · Is there shared work, such as a shared inbox, customer list or team reports? · Must anything run when every laptop is closed? · Who is the decision maker? · Choose the setup · Finish the install
  🤖 Agent      claude-code 2.1.294 — level 2 of 3 (MCP not checked yet)
  ```
- The last line prints `"team_host" {"decision_maker":"Owner"}`.

Try other answers in a new home if you like: `"no"` + `"no"` gives `"personal"`, and `"both"` gives `"hybrid"`.

**Record:**
- Report: `✅ READY  (6 of 6 steps done) · starter@1.0.0`; Agent line `claude-code 2.1.296 — level 2 of 3 (MCP not checked yet)`
- Mode and roles: `"team_host" {"decision_maker":"Owner"}`
- Pass / Fail: Pass

---

## Test 3: `http:` and failing `https:` links

```bash
installer --home $T/h2 start --solution http://example.com/s.json
echo $?
ls $T/h2
installer --home $T/h3 start --solution https://example.com/no-such-file.json
echo $?
ls $T/h3
```

**Expected:**
- The first `start` prints `{"error":"Unsupported solution reference 'http://example.com/s.json': use file:<path> or https://…","code":2}` and exits `2`.
- The second `start` exits `2` with an error that names the URL. With internet access it says `answered HTTP <status>`; record the status you see.
  The run that produced this guide had no network access and printed `{"error":"Cannot fetch solution URL 'https://example.com/no-such-file.json' (fetch failed)","code":2}`.
- Both `ls` commands fail with `No such file or directory`: a refused link creates nothing.

**Record:**
- Second error (with the status): `Cannot fetch solution URL 'https://example.com/no-such-file.json' (fetch failed)`, exit 2. The tester's terminal could not resolve example.com (`curl: (6) Could not resolve host`), so no HTTP status was seen.
- Pass / Fail: Pass for the refusal, the exit codes and the empty `ls`; the online `answered HTTP <status>` message was not exercised

---

## Test 4: No known agent

```bash
taskfollow probe --profile $REPO/tests/fixtures/profiles/missing-agent.json
echo $?
```

**Expected:**

```
{"profile":null,"agent_version":null,"c2_shell":true,"c4_headless":false,"c4_schema":false,"c5_resume":false,"c6_mcp":"not_probed","support_level":0,"tier":"unknown","notes":["No known agent was found; fallbacks will apply"]}
0
```

The probe never fails because of the agent: a missing or broken agent is a result, not an error.

**Record:**
- Output: identical to Expected, exit 0
- Pass / Fail: Pass

---

## Test 5: Clean up

```bash
cd ~
rm -rf ~/installer-plan2-test
ls ~/installer-plan2-test
```

**Expected:** `ls` says `No such file or directory`. Nothing was installed outside `~/installer-plan2-test`.
