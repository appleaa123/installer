# Plan 4 live test guide (local MCP server + approvals)

Use this guide to check Plan 4 by hand on your own machine, against your real Claude Code. Each test gives the
commands to run, what you should see, and a place to record what you actually saw. If a result differs, collect the
items in **Diagnostics to capture** at the end of the [Plan 1 guide](2026-10-07-plan-1-live-test.md#diagnostics-to-capture).

The **Expected** lines below are what the plan predicts; they were not yet produced by running the commands. The
first person to run this guide replaces them with the actual output.

## What this build can and cannot do

Plan 4 adds: the installer's own MCP server (`installer mcp-serve`, registered in Claude Code as `installer` by the
install step `preflight.tools`), the `installer tool <name> '<json>'` fallback, approval items with action-hash tokens,
levels derived by the engine (L0–L3, with the compiled floor), the decision maker role, and the decision commands
`installer approvals list | approve | edit | reject`. The only tools in this version are `memo.*` (internal notes) and
`approvals.request | list | get`; business tools arrive with Plans 5 and 6. There are no reminders or channel buttons
yet: you decide in your own terminal.

Tests 3, 4, 6 and 7 make headless Claude Code calls, so they use a little of your plan or credit. Test 1 writes the
server `installer` to your **user** Claude Code config; Test 9 removes it. This guide needs no Skills Wiki key.

## Results summary

| Test | What it checks | Pass / Fail | Notes |
|---|---|---|---|
| 0 | Setup and install | Pass | Commit 152b8fd, Node v22.14.0 |
| 1 | The install registers the `installer` MCP server | Pass | `start` registered the server; complete after the 3 answers |
| 2 | Claude Code connects to it | Pass | Connected, stdio, right `--home` |
| 3 | Claude Code uses an L1 tool with no approval | Pass | Reply `1`; `tool.executed memo.add` by the agent |
| 4 | An L2 tool refuses; Claude Code asks for an approval | Pass | Item 1 pending, L2, member; Claude Code replied "Approval item id: 1" |
| 5 | Claude Code cannot approve its own request | Pass | Refusal text exact; item stayed pending; `approval.refused` in the audit |
| 6 | You approve; Claude Code runs exactly that once | Pass | Approved by you at 16:02:24; agent ran `memo.edit` at 16:04:05; item `used` |
| 7 | L3 needs the decision maker; the CLI fallback | Pass | All steps match except the replay message (see Test 7) |
| 8 | The audit chain is whole | Pass | Chain ok (17 lines); `tool.refused` was 1, not 2 (see Test 8) |
| 9 | Clean up | Pass | Server removed; other connections untouched |

---

## Test 0: Setup and install

```bash
export T=~/installer-plan4-test
export REPO=/Users/allenliu/Desktop/ML-Project/installer
export PREFIX=$T/npm
mkdir -p $T $PREFIX

node --version            # must be v22 or later
cd $REPO && git log --oneline -1

npm install && npm run build && npm pack --pack-destination $T
npm install -g --prefix $PREFIX $T/installer-0.1.0.tgz
export PATH=$PREFIX/bin:$PATH
which installer
cd $T
```

**Expected:** `which installer` prints `<your home>/installer-plan4-test/npm/bin/installer`.

**Record:**
- Commit shown by `git log`: 152b8fd (docs: note the terminal-check caveat in D61)
- Pass / Fail: Pass (2026-10-12)

---

## Test 1: The install registers the `installer` MCP server

This test uses a small local solution with no Skills Wiki steps:

```bash
cat > $T/approvals-demo.json <<'JSON'
{
  "id": "approvals-demo",
  "version": "1.0.0",
  "steps": [
    { "step_id": "preflight.probe", "phase": "PREFLIGHT", "type": "auto", "title": "Check what your agent can do", "why": "Later steps adapt to it.", "blocking": true, "auto": { "action": "probe_runtime" } },
    { "step_id": "preflight.tools", "phase": "PREFLIGHT", "type": "auto", "title": "Connect your agent to the installer's tools", "why": "Approvals and local tools.", "blocking": true, "auto": { "action": "register_tools_mcp" } },
    { "step_id": "mode.shared-work", "phase": "MODE", "type": "ask", "title": "Is there shared work?", "why": "Decides the setup.", "blocking": true, "input": { "kind": "choice", "options": ["no", "yes", "both"] } },
    { "step_id": "mode.always-on", "phase": "MODE", "type": "ask", "title": "Must anything run when every laptop is closed?", "why": "Decides the setup.", "blocking": true, "input": { "kind": "choice", "options": ["no", "yes"] } },
    { "step_id": "mode.decision-maker", "phase": "MODE", "type": "ask", "title": "Who is the decision maker?", "why": "This person approves floor-level actions.", "blocking": true, "input": { "kind": "text" } },
    { "step_id": "mode.derive", "phase": "MODE", "type": "auto", "title": "Choose the setup", "why": "From your answers.", "blocking": true, "auto": { "action": "derive_mode", "args": { "shared_work": "mode.shared-work", "always_on": "mode.always-on", "decision_maker": "mode.decision-maker" } } }
  ]
}
JSON
installer --home $T/h1 start --solution file:$T/approvals-demo.json
installer --home $T/h1 submit mode.shared-work --value '"no"'
installer --home $T/h1 submit mode.always-on --value '"no"'
installer --home $T/h1 submit mode.decision-maker --value '"Owner"'
```

**Expected:** `start` probes Claude Code (10–30 seconds), registers the server, then shows `mode.shared-work`; the last
`submit` prints `{"status":"complete"}`.

**Record:**
- Last line: `{"status":"complete"}`
- Pass / Fail: Pass

---

## Test 2: Claude Code connects to it

```bash
claude mcp get installer
```

**Expected:**

```
installer:
  Scope: User config (available in all your projects)
  Status: ✔ Connected
  Type: stdio
  Command: <your node>
  Args: <your prefix>/lib/node_modules/installer/dist/cli.js --home <your home>/installer-plan4-test/h1 mcp-serve
```

**Record:**
- Output: `Status: ✔ Connected`, `Type: stdio`, Command `/usr/local/bin/node`, Args `…/dist/cli.js --home …/h1 mcp-serve`
- Pass / Fail: Pass

---

## Test 3: Claude Code uses an L1 tool with no approval

```bash
claude -p "Use the installer tools: add a memo with the text 'Order more paper', then list the memos. Reply with the new memo's id only." \
  --output-format json --allowedTools "mcp__installer__memo_add mcp__installer__memo_list" < /dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result))'
tail -1 $T/h1/audit/audit.jsonl
```

**Expected:** `1`; the last audit line has `"event":"tool.executed","ref":"memo.add"`.

**Record:**
- Pass / Fail: Pass (reply `1`; audit `actor:agent`, `tool.executed`, `memo.add`)

---

## Test 4: An L2 tool refuses; Claude Code asks for an approval

```bash
claude -p "Use the installer tools to change memo 1 to 'Order more paper and ink'. If the tool needs an approval, request one with a one-sentence why and reply with the item id only." \
  --output-format json --allowedTools "mcp__installer__memo_edit mcp__installer__approvals_request" < /dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result))'
installer --home $T/h1 approvals list
```

**Expected:** Claude Code replies `1`. `approvals list` prints one item: `"id":1`, `"status":"pending"`, `"level":"L2"`,
`"required_role":"member"`, `"action":{"tool":"memo.edit","args":{"id":1,"text":"Order more paper and ink"}}`,
`"expected_values":{"text":"Order more paper"}`, Claude Code's `why`, and no token.

**Record:**
- Item: id 1, pending, L2, member, `memo.edit` with the new text, expected_values `Order more paper`, why from Claude Code, no token
- Pass / Fail: Pass (Claude Code replied "Approval item id: 1")

---

## Test 5: Claude Code cannot approve its own request

```bash
claude -p "Run this shell command and reply with its output only: installer --home $T/h1 approvals approve 1" \
  --output-format json --allowedTools "Bash(installer:*)" < /dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result))'
installer --home $T/h1 approvals list | grep -o '"status":"[a-z]*"'
```

**Expected:** the output is the refusal
`{"error":"Approvals are decided by a person in their own terminal, not by the agent: open a terminal and run 'installer approvals approve 1' there","code":2}`,
and the item is still `"status":"pending"`; the last audit line is `"event":"approval.refused"`.
**If the item became approved, record FAIL and stop:** Claude Code's shell then has a terminal, and decision D61 must change.

**Record:**
- Output:
- Output: the exact refusal JSON (code 2); item still `pending`; last audit event `approval.refused`
- Pass / Fail: Pass

---

## Test 6: You approve; Claude Code runs exactly that once

```bash
installer --home $T/h1 approvals approve 1
claude -p "Approval item 1 is approved. Get it with approvals.get, run the approved memo edit with its approval_token, then list the memos and reply with memo 1's text only." \
  --output-format json --allowedTools "mcp__installer__approvals_get mcp__installer__memo_edit mcp__installer__memo_list" < /dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result))'
installer --home $T/h1 approvals list | grep -o '"status":"[a-z]*"'
```

**Expected:** `approve` prints the item with `"status":"approved"`, `"decision":{"decision":"approved","by":"terminal","role":"member",…}`
and a `next` line telling you to hand back to the agent (no token). Claude Code replies `Order more paper and ink`. The item is now `"status":"used"`.

**Record:**
- Pass / Fail: Pass (approved by terminal as member; agent ran the edit once; item `used`; the first two attempts at the Claude Code command failed because of terminal line-wrapping, not the installer)

---

## Test 7: L3 needs the decision maker; the CLI fallback

```bash
installer --home $T/h1 tool memo.delete '{"id":1}'; echo " exit=$?"
installer --home $T/h1 tool approvals.request '{"tool":"memo.delete","args":{"id":1},"why":"The memo is done."}'
installer --home $T/h1 approvals approve 2; echo " exit=$?"
installer --home $T/h1 approvals approve 2 --as 'Owner'
TOKEN=$(installer --home $T/h1 tool approvals.get '{"id":2}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).approval_token))')
installer --home $T/h1 tool memo.delete "{\"id\":1,\"approval_token\":\"$TOKEN\"}"
installer --home $T/h1 tool memo.delete "{\"id\":1,\"approval_token\":\"$TOKEN\"}"; echo " exit=$?"
```

**Expected:**
- The first call exits `2` with `memo.delete is L3 (floor: irreversible): a person must approve it first. …`.
- The request prints item `2` with `"level":"L3","required_role":"decision_maker"`.
- `approve 2` without `--as` exits `2`: `Approval item 2 is L3 and needs the decision maker: run it again with --as <decision maker's name>`.
- `approve 2 --as 'Owner'` prints `"status":"approved"` with `"role":"decision_maker"`.
- The delete prints `{"deleted":true,"id":1}`; running it again exits `2`. The message is `Approval 2 was already used; request a new approval` when the tool's lookup still succeeds (for example `memo.edit`), but for `memo.delete` the memo is already gone, so the lookup fails first and the message is `No memo 1`. Either way nothing is deleted twice.

**Record:**
- Pass / Fail: Pass; the replayed delete said `No memo 1` (the memo was already deleted), not the `already used` text

---

## Test 8: The audit chain is whole

```bash
node --input-type=module -e "const { verifyAudit } = await import('$PREFIX/lib/node_modules/installer/dist/core/audit.js'); console.log(JSON.stringify(await verifyAudit('$T/h1')))"
grep -o '"event":"[a-z.]*"' $T/h1/audit/audit.jsonl | sort | uniq -c
```

**Expected:** `{"ok":true,"lines":…}`; the events include `approval.requested` (2), `approval.refused` (2),
`approval.approved` (2), `tool.refused` (1 or more: Claude Code may request the approval without first trying the L2 edit, and the replayed delete fails on the missing memo before the gate), `tool.executed` (3).

**Record:**
- Pass / Fail: Pass (`{"ok":true,"lines":17}`; approval.* 2/2/2, tool.executed 3, tool.refused 1)

---

## Test 9: Clean up

```bash
claude mcp remove -s user installer
cd ~
rm -rf ~/installer-plan4-test
claude mcp get installer; echo " exit=$?"
```

**Expected:** `Removed MCP server installer from user config`, then `exit=1`. Nothing was installed outside
`~/installer-plan4-test` apart from that registration.
