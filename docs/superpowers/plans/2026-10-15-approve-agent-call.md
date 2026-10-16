# Plan: a person approves, then the agent makes exactly that call (postponed item 2)

Status: **revised after Fable's review (2026-10-15); the "Revised design" section below wins over the draft above it.**
Branch `feat/approve-agent-call`, stacked on `fix/flaky-tests` (#39).

## The problem
Task steps (D142) let a workflow use the person's own tools: Shopify CLI, MCP servers. A step that may change
things (`changes: true`) acts at once. Nobody approves the exact change first.

Sending to customers already works the safe way: an `approve` step makes an approval item bound to one exact call
(`action_hash` = sha256 of tool, args and expected values), the run waits, and on "yes" TaskFollow makes that call.

Calls to the agent's own tools are not TaskFollow tools, so this pattern does not reach them yet. The requirement is
that the approved thing is exactly what gets published.

## Design: approve one exact agent call; the agent may then make only that call
A new form of the existing `approve` step:
```json
{ "id": "publish",
  "approve": {
    "agent_call": { "tool": "mcp__shopify__productUpdate", "args": "${draft.call}" },
    "why": "Publish the new product" } }
```
- `tool` is one agent tool, written as a task's `may_use` entry would be, but **exact**: `mcp__<server>__<tool>` (no
  wildcard), or `Bash`.
- `args` is a template resolving to an object. For an MCP tool it holds that tool's arguments. For `Bash` it is
  `{ "command": "<one command>" }`.
- Usually the args come from an earlier read-only task step that drafted the call (its `output` schema asks for it).

**Asking.** The runner builds `{tool, args}` and refuses it before asking when:
- the tool is not exact;
- a `Bash` command contains `; & | > < \`` or `$(`, or a new line (the same rule as the task hook);
- the args are not an object, or are larger than 20 kB.

Then it creates an approval item:
- `action = {tool, args}`, `expected_values = {}`, `action_hash = actionHash(tool, args, {})`;
- `source.via = "runner"`, `source.run` set, `policy: false`;
- level **L3** (outside TaskFollow, often visible to customers), so the decision maker decides. Earned autonomy
  never applies (`policy: false`).
- The preview is the call in plain words: the tool name, then the args as indented JSON, cut at 1,500 characters
  with "… (full call in `taskfollow approvals show <id>`)".

The run waits, as today. In a sandbox run the step is skipped (output `null`), like a task step that may change
things. **Editing** an agent call in the approval is refused in v1, in plain words: reject it and run again.

**Making the call** (`checkApproval`, approved). Instead of `invokeTool`, the runner runs a task with the person's
agent (`runTask`):
- `may_use: [tool]`, `changes: true`, timeout 5 minutes;
- prompt: "Make exactly this one call and nothing else: tool <tool> with these arguments <args JSON>. Do not change
  the arguments. Then answer `{\"done\": true}` and include the tool's answer in `result`."
- output schema `{done: boolean, result?: any}`.

The task hook config gains `exact: {tool, args, hash}`. With `exact`, the gate:
- **allows** a call only when its tool equals `tool` and its input equals `args` by canonical JSON (for `Bash`,
  compare only `command`, trimmed; Claude Code adds fields such as `description`);
- **allows it once.** A second matching call is denied ("the approved call was already made"). The hook records the
  allowed call in the step's record, and the pre-phase reads the record to see whether one is already there;
- **denies** everything else, saying: "Only the approved call may run: <tool> with exactly the approved arguments."

**After the agent ends**, the runner checks the step's record, not the agent's word:
- **exactly one** call of `tool` with outcome `ok`: the step is done, with the agent's answer as output, and an audit
  entry `run.agent_call_made` with the item id and hash;
- **no such call**: the step fails, saying "the agent did not make the approved call", and the approval is spent;
- **`failed`**: the step fails with the tool's failure. The approval is spent; nothing is retried by itself.

The step is marked started before the agent runs, as task steps are. After a crash, the run stops for a person and
does not try the call again (it may have happened).

**Why the agent makes the call, not TaskFollow.** MCP servers live in the person's agent (D136). TaskFollow cannot
call them itself. The hook makes the agent's freedom zero: only the one approved call, once.

## Binding content, not just an id
"Publish product 123" approved, then the product edited in another session before publishing, would publish
something the person never saw. INSTALL.md §9b and the store example will say: put the full content in the approved
call (title, description, price and status together, e.g. one `productUpdate` with every field), so publishing
writes exactly what was approved. The draft-first pattern (create unpublished, then approve the publish call) stays
possible, but is described as weaker.

## Where code goes
| File | Change |
|---|---|
| `workflow.ts` | Parse `approve.agent_call` (exact tool, args template); `approve.tool` and `agent_call` are mutually exclusive |
| `agent-call.ts` (new, small) | Validate the call, build the preview, run the task with `exact`, check the record afterwards |
| `runner-steps.ts` | `runApprove` / `checkApproval` branch to `agent-call.ts` |
| `agent-hook.ts` | The `exact` decision (canonical compare, once); `HookConfig.exact` |
| `agent-task.ts` | Pass `exact` into the hook config |
| `approvals.ts` | Refuse an edit of an agent call |
| `INSTALL.md` §9b + the store example | The order workflow's publish step uses `agent_call`; a D-entry (D151) |

## Testing (test-first; fakes only, then a human task on the real store)
- **Unit:**
  - parsing (exact tool only; Bash join refused; args must be an object);
  - the item's hash, level and preview;
  - the hook with `exact`: same args with keys in another order is allowed; one changed value is denied; a second
    identical call is denied; Bash compares only `command`;
  - the record check (one ok, none, failed, two);
  - edit refused;
  - sandbox skip;
  - crash after start is not retried.
- **E2E with the fake agent** (it already plays scripted tool calls through the real hook):
  - draft task → approve → yes → the fake makes the call → done;
  - the fake tries changed args, then the exact args: the first is denied and recorded, the second runs;
  - the fake makes no call: the step fails;
  - rejected: the run stops and the agent is never started.
- **Human task 28** (about 20 minutes, the owner's test store): a workflow drafts a product change (title and
  description) read-only; the owner approves on the terminal; the agent makes the call through the Shopify CLI or the
  claude.ai connector. Check the store shows exactly the approved text, `why` shows the call and the approval, and a
  changed-args attempt (asked for in the prompt) is refused.

## Slices
1. Hook `exact` (unit).
2. Parsing and approval item (unit).
3. Running the approved call and the record check, with fake-agent e2e.
4. Docs: §9b example, D151, human task 28.

## Open questions for review
1. Is L3 (decision maker, never earned autonomy) right for every agent call, or should the workflow choose L2 or L3?
2. Canonical JSON equality for MCP args: will Claude Code pass `tool_input` exactly as the model wrote it (types,
   no added defaults), or should the comparison allow keys the approved args did not have?
3. Is reading the record inside the pre-hook enough for "once", given that hooks for parallel tool calls may run at
   the same time? Should it use a lock file instead?
4. Should a failed approved call be retryable by the person (`taskfollow run … --resume`) with the same approval, or
   always need a new approval?

## Fable's review (2026-10-15), applied
- **Blockers**
  - **B1. Once.** The pre-hook writes nothing on allow, so "once" cannot be read from the record. Fix: an
    exclusive-create marker `runs/<wf>/<run>/<step>.made` (`open(…, "wx")`) before allowing; if it already exists,
    deny.
  - **B2. The hook fails open on its own errors.** Any throw exits 1, and the call goes ahead. A timeout also lets the
    call go ahead (Claude Code docs, checked: "A timed-out command … hook doesn't block the tool call"). Fix:
    - every throw in `agent-hook` exits 2;
    - the PreToolUse entry gets `onFailure: "block"` (documented; needs Claude Code 2.1.295 or later). This applies
      to **all** task steps.
  - **B3. Spending the approval.** It is unspecified. Fix: `redeemToken` before the agent starts (D58 order), and
    drive the agent from `item.action`.
  - **B4. Crash and resume ask the person again.** Fix: the interrupted check in `runner.ts` works for every step
    kind; the interrupted log keeps `approval: id`.
  - **B5. Editing is reachable** from `approvals decide` and from the channel `E<id>` code, and both hit "unknown
    tool". Fix: an `isAgentCall` guard before preparing in both places; the announcement offers no `E`.
  - **B6. `Bash` does not fit** `may_use` and `--allowedTools`. Fix: cut Bash from v1 (MCP only, as proven in task
    25).
- **Should fix**
  - **S1.** Exact mode still allows `actions_reason` and `StructuredOutput`.
  - **S2.** Post-run check: a marker **and** exactly one post/failed line. A line without a marker means the call ran
    past the gate (fail and audit). A marker without a line means it may have been made (fail, wording as
    `TASK_INTERRUPTED`).
  - **S3.** Record `failed` when an MCP `tool_response.isError === true`. "Done" means made with no error reported.
  - **S5.** A denied attempt is told the approved JSON (up to 4 kB). Strict equality is kept (no `updatedInput`).
  - **S6.** No custom preview and no `approvals show`. The existing preview prints `tool` plus the canonical args;
    `approvals list` has the whole action.
  - **S7.** The args go in the task's `input` (the untrusted block), are never stripped, and the hash covers the
    same object.
- **Minor.** No new audit event (M1). `why` needs no change (M2). No `exact.hash` (M3). A hand-built L3
  `PreparedAction` (M4). Output schema `{done: boolean}` (M5). §9b: copy the tool name exactly as Claude Code shows
  it (M6).
- **Open questions answered**
  - **Q1.** Fixed L3.
  - **Q2.** Strict canonical equality of the whole object. Check it on the real Claude Code in task 28.
  - **Q3.** The marker.
  - **Q4.** No retry on the same approval: "run the workflow again for a new approval".

## Revised design (what gets built)
1. **Gate hardening, all task steps.**
   - The PreToolUse entry gets `onFailure: "block"`.
   - `agent-hook` turns any throw into exit 2.
   - `profiles/claude-code.json` `min_version` becomes 2.1.295.
2. **Hook exact mode.** `HookConfig.exact = {tool, args}`.
   - The reason tool and `StructuredOutput` are always allowed.
   - A call to `tool` whose input is canonically equal to `args` creates `<record minus .calls.jsonl>.made` with
     `wx`, then it is allowed. If the marker exists, it is denied.
   - Anything else is denied, with the approved JSON (≤ 4 kB) in the reason.
   - In the post phase, `tool_response.isError === true` is recorded as `failed`.
3. **Approve step `agent_call`** (MCP only: `mcp__<server>__<tool>`, no wildcard).
   - The args template must resolve to an object of at most 20 kB.
   - A hand-built L3 `PreparedAction` with reason "a call to the agent's own tool, outside TaskFollow".
   - `policy: false`, the default preview. Skipped in a sandbox run.
4. **On approval** (`agent-call.ts`):
   - `redeemToken`;
   - save `{…waiting log, status: failed, error: TASK_INTERRUPTED}`;
   - `runTask` with `may_use: [tool]`, `changes: true`, `input: item.action.args`, `exact`, 5 minutes, output
     `{done: boolean}`;
   - seal the record;
   - check the marker plus exactly one post/failed line → done, or fail with a plain reason ("run the workflow again
     for a new approval").
5. **`runner.ts`:** the interrupted check works for every step kind.
6. **The `isAgentCall` guard** in `approval-commands.ts` and in the reply codes (no `E` offer, `E` refused).
7. **Docs.** §9b example (a draft task, then `agent_call` with the full product fields), D151, human task 28
   (MCP connector on the test store; check the store shows exactly the approved text, that `onFailure` is accepted,
   and the record matches the approved args as emitted).

Slices:
1. Gate hardening.
2. Exact mode.
3. Parsing and approval item.
4. On-approval run and resume.
5. Edit guards.
6. Docs.

## Fable's code review (2026-10-15), applied
- **Must fix**
  - **1. Results.** The result check now needs exactly one result in the whole record, for the approved tool, after
    the marker. A result for another tool, a second result, or a result without the marker fails the run and is
    audited.
  - **2. Agent version.** The version is enforced where task steps run: the task command has its own
    `task.min_version` (2.1.295), checked before the agent starts, so the approval is not spent. The profile's
    general minimum went back to 2.1.0, so older agents keep their tier for everything else.
- **Should fix**
  - A damaged record is a plain failure.
  - The record folder is made before the token is spent.
  - Tests now cover the draft → `${draft.call}` → approve → call path end to end, a crash after the token is spent,
    each failure case, and the version check.
  - Human task 28 steps 5 and 6 are rewritten to be doable.
  - The edit refusal moved into `editItem` and is audited.
- **Minor**
  - `AGENT_CALL_MAX_BYTES` is no longer exported.
  - `madeMarker` is simplified.
  - The size and type tests assert their reasons.
  - D151 says that a dry run surfaces an oversized call.
