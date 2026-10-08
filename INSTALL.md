# Install this solution

You are the operator of this install. A person asked you to install a solution. Follow these steps exactly.

## 1. Install the installer

```bash
{{INSTALL_COMMAND}}
```

## 2. Let the person store their Skills Wiki key

```bash
installer secret skillswiki
```

This prints `{"status":"waiting","url":"http://127.0.0.1:…"}` and opens that page in the person's browser. Tell the person to paste the API key from their Skills Wiki dashboard into the page and press Save; the key goes into their keychain and never passes through you. If the output has a `hint`, relay it word for word (it says how to reach the page from another computer). Wait until the person says the page shows Done, then go on to step 3: `installer start` refuses to run while the key is missing and says so; if that happens, ask the person to finish the page, then run the start command again.

## 3. Start the install

```bash
installer start --solution {{SOLUTION_REF}} --url {{SKILLSWIKI_URL}}
```

`--url` is the MCP URL from the person's Skills Wiki dashboard; it is not a secret. Run this from the folder you work in: the install connects Skills Wiki to you in that folder.

## 4. Repeat until the install is finished or blocked

Every command prints one line of JSON. Read its `status`:

- `"step"`: act on `view.step` by its `type`.
  - `ask`: ask the person the step's `title` and tell them its `why`. Then run `installer submit <step_id> --value '<json>'`. Text answers are JSON strings, for example `--value '"North team"'`. A value that starts with `-` uses the `=` form: `--value=-5`.
  - `human_action`: tell the person the `instructions` and the `why`, and wait until they say it is done. Then run `installer verify <step_id>` if the step has a `verify`, otherwise `installer submit <step_id> --done`. When `input.kind` is `secret`, the person enters it on the page from `installer secret <input.provider>` (run that again if the page was closed); never ask for the value itself.
  - `agent_action`: do the `intent` yourself, following `view.hints` when present. Then run `installer verify <step_id>`.
- `"failed"` or `"blocked"`: tell the person the `hint` and the command in `view.resume`. Stop and wait for them.
- `"complete"`: run `installer report` and show it to the person.

`installer next` shows the current step again. `installer report` shows progress. After a break of minutes or days, `installer resume` continues where the install stopped.

## 5. The installer's tools and approvals

The install connects you to the installer's own MCP server, `installer`; its tools appear to you as `mcp__installer__memo_list`, `mcp__installer__approvals_request` and so on. If you cannot use MCP tools, run the same tools from the shell: `installer tool <name> '<json arguments>'`, for example `installer tool memo.list '{}'`. Both follow the same rules.

A tool that changes something a person must approve first (level L2 or L3) refuses to run and says so. Then:

1. Call `approvals.request` with `{"tool":"<name>","args":{…the same arguments…},"why":"<one sentence>"}`. It answers with an item `id`.
2. Tell the person what you want to do and why, and ask them to run `installer approvals approve <id>` in their own terminal. They can also change it with `installer approvals edit <id> --value '<json arguments>'` or refuse it with `installer approvals reject <id> --reason '<text>'`. An L3 item needs the decision maker: `installer approvals approve <id> --as '<their name>'`.
3. When the person says they decided, call `approvals.get` with `{"id":<id>}`. If it is approved, call the tool again with exactly the arguments in `action.args` plus `"approval_token"`. A token works once.

## Removing the connection

`installer disconnect skillswiki` removes the Skills Wiki server from your configuration and deletes the key from the keychain.

## Operator rules

1. Never invent an answer on the person's behalf; ask.
2. Always tell the person why a step is needed (from the step's `why`).
3. Never request, repeat or store secrets in chat. Keys and sign-ins are entered on a page the installer opens on this computer, never through you.
4. At a blocking human step, stop; state exactly what to do and how to resume (`installer resume`).
5. After every `agent_action`, run the step's verify (`installer verify <step_id>`).
6. Never approve, edit or reject an approval yourself, and never ask the person for a token: only the person decides, in their own terminal.
