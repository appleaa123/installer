# Human tasks

Tasks only a person can do. Claude adds to this list during development; tick items off as you go.
Each task says why it is needed and what to do, step by step.

## Open

### 1. Review and merge the open pull requests (in order)

**Why:** each plan's work waits on a branch until you approve it. Nothing is merged into `main` without you.

1. Open PR #2 (D34 fixes and Plan 1 review follow-ups): https://github.com/appleaa123/installer/pull/2
   - Read the summary and the test plan. Ask Claude about anything unclear.
   - When happy, choose **Create a merge commit** (keeps the separate commits) and merge.
2. Open PR #3 (Plan 2, runtime conformance): https://github.com/appleaa123/installer/pull/3
   - Its base is `feat/engine-core`. After #2 is merged, GitHub may ask to change the base to `main`: click **Edit** next to the title and pick `main`, or ask Claude to do it.
   - Read the "Known limits" section: the Windows agent detection is deferred, and four small findings are deferred.
   - Merge with **Create a merge commit**.
3. Later PRs (Plan 3 onward) appear here as they open, each stacked on the previous one. Merge them in order.

### 5. Create your own Google OAuth client for the Sheets connector, and decide whether to publish a shared app

**Why:** R3 says no client may depend on your Google account or OAuth app. In v1 every client creates their own OAuth client in their own Google Cloud project, and `taskfollow secret google` signs in with it (D66). You need one too, made exactly the way a client would make it, for the Plan 5 live test. Use the Google account that owns your test spreadsheet. About 10 minutes.

1. Open https://console.cloud.google.com/ and sign in with that Google account.
2. In the project picker at the top, choose **New project**, name it (for example `installer-sheets`), press **Create**, then select the new project.
3. Open **APIs & Services → Library**, search for **Google Sheets API** and press **Enable**. Enable nothing else.
4. Open the OAuth consent screen (**APIs & Services → OAuth consent screen**; newer consoles call it **Google Auth Platform**, with the pages **Branding**, **Audience** and **Data access**). Choose user type **External** (a Google Workspace organisation can choose **Internal**, which needs no test users). Fill in the app name, the support email and the developer contact, and save.
5. On **Audience** (or **Test users**), add the Google address you will sign in with. While the app is in **Testing**, only these addresses can sign in. The guide then moves the app to **In production**, after which the test-user list no longer matters.
6. Optional: on **Data access** (or **Scopes**), add `https://www.googleapis.com/auth/spreadsheets`. The installer asks for this scope only.
7. Open **APIs & Services → Credentials** (or **Google Auth Platform → Clients**), choose **Create credentials → OAuth client ID**, application type **Desktop app**, give it a name and press **Create**. Copy the **Client ID** and the **Client secret**. Add no redirect URI: a Desktop app client accepts the installer's own `http://127.0.0.1:<port>/` page. The client type must be **Desktop app**: a Web application client makes Google answer `Error 400: redirect_uri_mismatch`, and the installer's page uses a random local port that cannot be registered. If the console offers "Use this client for an AI-powered agent", leave it unchecked: the installer is a local program that calls the Sheets API itself.
8. Keep both values out of chat and out of the repository. The installer's page asks for them. For the automated live test (`npm run test:live`), put them in your own `~/.config/installer-dev/.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, next to `GOOGLE_REFRESH_TOKEN` and `GOOGLE_TEST_SHEET_ID` (check that the file uses these four names; Claude never reads it). The live guide's Test 2 shows how to copy the refresh token from your keychain.
9. Two things Claude could not check without a real sign-in; note what you see during the live guide: (a) Google accepts the loopback redirect without a registered redirect URI (if the consent page says `redirect_uri_mismatch`, check that the client type is **Desktop app**); (b) while the consent screen is in **Testing**, Google shows an "unverified app" warning and may end the refresh token after about 7 days, after which `taskfollow secret google` has to be run again.

**Decided 2026-10-12 (D123):** clients keep their own Google app; there is no shared verified app. A client gets the step-by-step help from `taskfollow guide google-sheets`, which the agent reads from Google's current documentation, so these steps stay in sync with Google without edits here. The two rules the guide insists on: the client type is **Desktop app**, and the app is set to **In production** (or Workspace **Internal**) before the first sign-in so it never expires after 7 days.

### 13. Set up a team host: the dedicated user, the host readiness fixes and the boot services

**Why:** on a Team host the assistant must keep running when nobody is at the computer (D42), and the engine should belong to an OS user of its own rather than to a person's account (D50, D61, D105). The installer only reads the settings and prints what to change; a person with administrator rights makes every change. Do this on the client's always-on computer during their install (and once on a spare Mac or Linux box if you want to see it before a client does). About 30 minutes.

1. Create the engine user, as `taskfollow host` prints it: on macOS a standard (not administrator) user named `installer-engine` (System Settings → Users & Groups → Add User); on Linux `sudo useradd --create-home --shell /bin/bash installer-engine`, then `sudo passwd installer-engine`. Keep its password yourself.
2. Sign in as `installer-engine`, install Node 22, the agent and the installer there, and run the install from that account, so the engine home, its keychain items and the agent's MCP servers belong to it.
3. As `installer-engine`, run `taskfollow host`. For every check whose status is `fix`, run its command from your own administrator account (for example `sudo pmset -a sleep 0` and `sudo pmset -a autorestart 1` on macOS, `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target` and `sudo timedatectl set-ntp true` on Linux). Turn on FileVault (macOS) if it is off, keeping the recovery key yourself (the engine never stores it, D43). On Linux, set the firmware's power-loss setting to Power On.
4. As `installer-engine`, run `taskfollow schedule remove` if the per-user schedule was loaded (and the commands it prints), then `taskfollow gateway stop` and `taskfollow host service install`; run the printed `sudo cp`, `chown`, `chmod` and `launchctl bootstrap system …` (macOS) or `systemctl enable --now …` (Linux) commands from your administrator account. On Linux the tick stays the engine user's crontab (`taskfollow schedule install`).
5. Follow the `updates` advice: schedule OS updates and planned restarts in the quiet window `taskfollow host` names; put the computer on a wired network and a UPS.
6. Run `taskfollow doctor` as `installer-engine`: the `host` check should say `readiness 5/5` (4/4 on Linux), or fewer with a `not read:` list of settings it could not read (on macOS the time-sync setting needs administrator rights to read), which you then check by hand and the `gateway` and `runner` checks `ok` after a minute. Decide approvals from Telegram; the terminal-only commands remain for a person at that account.
7. Tell Claude the readiness score you saw and any check that stayed `unknown`.

### 15. Install Codex and certify it (O1)

**Why:** the Codex profile (D113) was written from Codex's documentation; nobody has run it, because Codex is not installed on the development machine. Its terms are reviewed (task 17, D121); its tier stays Unknown until a certification passes. It uses your ChatGPT plan's Codex allowance (a few short calls).

1. Install the Codex CLI as OpenAI's documentation says (for example `npm install -g @openai/codex`), sign in (`codex login`) and check that `codex --version` prints `codex-cli <version>`.
2. In an empty folder, check the three documented facts by hand: `codex exec --json --skip-git-repo-check "Reply with exactly this word: alpha"` prints JSON lines, among them `{"type":"thread.started","thread_id":…}` and an `item.completed` line whose `item.type` is `agent_message` and `item.text` is `alpha`; `codex exec resume --json --skip-git-repo-check <thread_id> "What word did you just reply with?"` answers in the same thread; and `--output-schema <file>` with a JSON schema file makes the answer JSON that fits it.
3. From the repository, run `node dist/cli.js probe --profile codex`: C4, C4 schema and C5 should pass, and the tier stays `unknown` until a certification passes.
4. Run Test 5 of the Plan 10 guide (`taskfollow certify --profile codex`).
5. Paste everything to Claude. Claude corrects the profile from what you saw (flags, `min_version`, a stricter tools-off switch than `--sandbox read-only` if Codex has one). Then you certify again.

### 16. Certify on Windows (only before a client runs on Windows)

**Why:** on Windows the engine runs an npm shim's script with `node` instead of `claude.cmd`, never through a shell (D115). That was tested only against sample shim files, not on a Windows machine, so Windows stays Unknown. Scheduling and the OS keychain were added for Windows in D128 (task 22 tries them); host readiness is not supported on Windows yet (D120), and some offline tests check POSIX file modes, so expect the offline suite to report failures there; the list is what Claude needs.

1. On a Windows 11 machine or VM with Node 22 and Git, install Claude Code (`npm install -g @anthropic-ai/claude-code`), sign in, clone the repository, then `npm ci` and `npm run build`.
2. In PowerShell, in the repository: `node dist/cli.js probe --profile claude-code`. Expected: C4, C4 schema and C5 pass (the engine found `claude.cmd`, read it and ran its script with `node`), and the tier is `unknown` with the note "Windows is not certified yet".
3. Windows now has its own protected-storage backend (D128; task 22 tries it), so a file keychain is only needed if that fails: if you must, set one: `$env:INSTALLER_KEYCHAIN="file"; $env:INSTALLER_KEYCHAIN_DIR="$HOME\installer-keys"`, set the live keys in the same window, then `npm run certify -- --profile claude-code --home $HOME\installer-certification`.
4. Paste the probe's output, the record and any error to Claude. When everything passes, Claude lifts the Windows cap in the probe.

### 17. Review the vendors' terms (O2)

**Why:** decision D32: each runtime's terms are read before the installer runs it for a client. Codex: done on 2026-10-12, `tos_review: ok` (D121). Antigravity's terms (clause 6) forbid other programs from invoking it, so it has no profile and the installer never calls `agy` (D114).

1. Codex: **done 2026-10-12, `tos_review: ok` (D121).** (Original step: read OpenAI's current terms of use and any Codex CLI terms or usage policy, looking for running Codex from another program, headless or unattended, and business use of a ChatGPT plan. Tell Claude what you found, with the date and the links: Claude sets `tos_review` to `ok` (or `blocked`) with that note.)
2. Antigravity (only if you want `agy` as an automatic model fallback): read its current Additional Terms, clause 6 in particular. Tell Claude; if they now allow it, Claude adds a profile as D114 describes and you certify it.
3. Before any other agent is certified later (OpenClaw, Hermes, Pi, WorkBuddy, O5), do the same for its vendor.

### 20. Prove that a production-status Google sign-in no longer expires after 7 days

**Why:** the guide tells clients to leave Testing status so the sign-in does not expire weekly. The token response carried `refresh_token_expires_in` on your app on 2026-10-12, while it was in Testing; it is believed to mark a refresh token that expires, and this task confirms that. About ten minutes now; a week later one repeat check.

1. In the Google Cloud console, set your test app's publishing status to **In production** (consent screen / Audience page).
2. Run `taskfollow secret google` and sign in again. Then copy only the new `refresh_token` to your clipboard, without printing it: `security find-generic-password -s installer -a google -w | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).refresh_token))' | pbcopy`, and paste it as the value of `GOOGLE_REFRESH_TOKEN` in `~/.config/installer-dev/.env` (never in the chat). Delete the temporary keychain item afterwards: `security delete-generic-password -s installer -a google`.
3. In a terminal, from the repository folder, in a subshell so the keys do not stay in your terminal: `( set -a; . ~/.config/installer-dev/.env; node docs/testing/google-token-probe.mjs )`. Tell Claude whether the first line still lists `refresh_token_expires_in`. If it no longer does, the sign-in is not marked to expire; if it still does, the guide's wording must change.
4. After 8 days or more, run the same command again (token endpoint 200 means the sign-in survived). Tell Claude, and Claude records the date in D123.

**Result of steps 1 to 3, 2026-10-14:** the app was set to In production (the console then shows "Your app requires verification", which needs no action) and the sign-in shows "Google hasn't verified this app" (Advanced, then Go to the app). The token response lists `access_token,expires_in,scope,token_type`: `refresh_token_expires_in` is gone, so the sign-in is not marked to expire. A first probe returned `invalid_grant` only because the old Testing token was still in `.env`. **Step 4 is still open: repeat the probe on or after 2026-10-22.** The token in `~/.config/installer-dev/.env` stays valid for it; do not remove the app's access at Google before then.

### 21. Try the email setup page with real mailboxes (before email is promised to a client)

**Why:** the provider table (D127) was read from each provider's help pages, but no real mailbox has signed in through the page yet. About 10 minutes per mailbox you have; skip any provider you have no account with and tell Claude which ones were not tried.

1. Run `taskfollow secret email`, open the page, and enter a **Gmail** address. Make an app password with the page's steps and paste it **with its spaces**. Expect "Connected". Then try a wrong password: expect a plain message that mentions the app password and 2-Step Verification, and nothing stored.
2. Try a **Google Workspace** (work) address if you have one: does the App passwords option exist? Tell Claude what you see.
3. **iCloud:** expect "Connected". If the sign-in is refused, tell Claude: the IMAP sign-in name may need to be the full address, not the part before the @.
4. **Yahoo**, **Fastmail**, **Zoho** (with IMAP access off, then on): expect "Connected" when set up as the page says; with Zoho IMAP off, the message names IMAP.
5. An **outlook.com** and a **Microsoft 365** address: expect the page to say it cannot connect Outlook/Hotmail (outlook.com) before asking for any password. A Microsoft 365 work address on its own domain is not recognised yet and will reach the password step: tell Claude what happens.
6. A wrong server under **Advanced**: expect the "could not reach the mail server" message within about 30 seconds.
7. After "Connected", run `taskfollow channel email` and then `taskfollow gateway start`; send the mailbox one message and check that the assistant sees it.
8. Leave the page open for 15 minutes before pasting the password: it should still work (the limit is 30 minutes).

### 22. Try TaskFollow on a real Windows 11 PC (before Windows is promised to a client)

**Why:** Windows support (D128) was built and tested on a Mac with a fake PowerShell and fake Task Scheduler. Nothing in it has run on Windows. About an hour. Use a **fresh standard (non-administrator) Windows user**, Node 22 LTS from https://nodejs.org and Claude Code installed as Anthropic documents. Use **Command Prompt** (Windows key, type `cmd`, Enter) for every command you run yourself. Tell Claude the result of each numbered item, with the exact output of anything that fails.

1. In Claude Code, ask it to run `node -p process.platform` (expect `win32`) and to run `echo $SHELL`. Tell Claude which shell Claude Code's tool uses (Git Bash or PowerShell).
2. Install the package (the tarball from `npm pack`, `npm install -g .\taskfollow-0.1.0.tgz`), then `taskfollow secret google`: the sign-in page should open by itself in your browser and **no black console window should stay behind**. After the page says Done, check that the file `%LOCALAPPDATA%\taskfollow\keys\google.dpapi` exists and does not contain your secret in readable form.
3. Choose a test secret with an accent and a double quote in it (for example `café"x`) on a `taskfollow secret` page and read it back through a live check: it must round-trip exactly.
4. Let Claude Code run the whole install from INSTALL.md (the default solution, no Skills Wiki). Tell Claude where it stalls. Repeat once with a Windows user name that contains a space.
5. In Command Prompt, as the person: `taskfollow approvals approve <id>` for a pending approval must be accepted (not refused as "the agent"). Try the same in PowerShell and in Git Bash and tell Claude what each says.
6. `taskfollow gateway start`: no console window may appear; `taskfollow gateway status` shows it running; `taskfollow gateway stop` works.
7. `taskfollow schedule install`, then run the printed `schtasks /Create ...` line in Command Prompt **without** "Run as administrator". It must succeed. Wait five minutes: `taskfollow schedule list` shows a recent `last_tick`, and no window flashes on screen. If no tick is recorded, tell Claude: the hidden-console setting (`conhost.exe --headless`) may need to change.
8. Unplug a laptop's charger: ticks must continue on battery.
9. Sign out and back in: ticks resume. Put the computer to sleep over a scheduled run: it must be recorded as `missed`.
10. `taskfollow uninstall` in Command Prompt: the stored keys are gone and the printed `schtasks /Delete ...` line removes the task.
11. Run task 16's certification and paste the results. When items 1 to 10 pass, Claude removes the word Preview.

### 23. Run the real-life install test with a non-technical person (Mac, then Windows)

**Why:** this is the only thing that can show whether the install works unaided. Two reviewers found real problems that no automated test had; fixing them is not the same as proving it. About half a day per person, plus a short check the next day. Follow `docs/testing/2026-10-14-real-life-install-test.md`: publish the package to npm first, use someone who has never used a terminal, do not help them, log every stall, and send Claude the sheet. Claude turns every intervention into a fix, and you repeat the test with a new person until one finishes with none.

### 24. Try Slack on a real workspace (before Slack is promised to a client)

**Why:** Slack (D135) was built against a fake Slack. About 30 minutes with a Slack workspace you own (a free one is fine). Tell Claude the result of each item, with the exact wording of anything that surprises you.

1. Run `taskfollow secret slack` and follow the page: create the app from the manifest (does Slack accept the pasted text? are the buttons named as the page says?), install it, copy the two tokens. On a workspace where only owners may install apps, see what Slack says and whether the page's "Request to Install" sentence fits.
2. Press Test and save: expect Connected. Try a wrong bot token and a wrong app token: each should name the right token.
3. Run `taskfollow channel slack`, then `taskfollow invite "<your name>"`, open the TaskFollow app in Slack (under Apps) and send `JOIN <code>`. Tell Claude whether the Messages tab accepts your messages, and whether Slack ever refuses a message that starts with a word like `JOIN`.
4. After you joined, send `pause`, then `unpause`. Tell Claude whether either was swallowed by Slack.
5. Make the assistant send you a note (a workflow with `channel.notify`) containing `@here`, `<!channel>` and a link: they must arrive as plain text.
6. Leave the gateway running overnight, close the laptop for an hour, open it again, and send a message: it must arrive once, and once only.
7. Remove the app from Slack (Apps, Manage) and watch `taskfollow doctor`: it should say the Slack app was removed in plain words.

### 26. Check watching with your real Claude Code (before watching is promised to a client)

**Why:** `taskfollow watch` (D146) edits your real `~/.claude/settings.json`; it was built against a copy. About 15 minutes. Tell Claude what happens at each step.

1. In your own terminal: `taskfollow watch add cli:shopify`, then `taskfollow watch on`. Open `~/.claude/settings.json` and check that only one new entry was added under `hooks.PostToolUse` and nothing else changed.
2. Start a new Claude Code session and ask it to run one read-only `shopify store execute` query. Then `taskfollow why direct`: the call should be there, with only `shopify store execute` and no query text.
3. If you use a Shopify MCP server or the claude.ai Shopify connector: `taskfollow watch add mcp:<its server name>` (the name in tool names, for example `claude_ai_Shopify`), ask for one read, and check `why direct` again.
4. Tell Claude whether the session felt slower on watched calls.
5. `taskfollow watch off`: the entry should be gone and the file otherwise as before.
6. `taskfollow watch ask Bash(shopify store execute:*)`, then ask Claude (new session) to run a read: does Claude Code ask you first? Then try it when you had earlier chosen "always allow" for that command: does it still ask? `taskfollow watch unask Bash(shopify store execute:*)` afterwards.

### 27. Try WhatsApp with a real business number (before WhatsApp is promised to a client)

**Why:** WhatsApp (D149) was built against a fake Meta and a fake Cloudflare. About an hour, with Meta's free test number first. Tell Claude what happens at each step, with exact wording of anything unexpected.

1. Make a free Cloudflare account and a Meta developer app (type Business) with WhatsApp added. Run `taskfollow secret whatsapp` and follow step 1: does the token with the three listed permissions work? Does a brand-new account get a workers.dev address?
2. Step 2: paste the callback address and verify token into Meta's webhook settings; does Meta accept them at once? Subscribe to `messages`. Make a system user token: which permissions did Meta ask for, and does it say it never expires?
3. Step 3: add your own number to the test number's allowed list, send a message, press Check: Connected?
4. `taskfollow channel whatsapp`, then send another message and check `channel.inbox`.
5. Ask Claude to send you a reply through an approval: it should arrive. Then wait more than 24 hours after your last message and try again: it must be refused before anything is asked.
6. If you can, have someone with a WhatsApp username (no visible number) write: does the message arrive, and does a reply reach them?
7. Note whether Meta asked you to switch the app to Live, and what it required.

## Optional

### 18. Check the crontab entry on a Linux host (only if a client will run on Linux)

**Why:** on Linux the runner's minute is a crontab line (D82). It was only checked as text on macOS.

1. On the Linux host, after `taskfollow start`, run `taskfollow schedule install` and run the one command it prints.
2. `crontab -l` shows a line that ends with `# com.installer.tick.<8 characters>`; after two minutes `taskfollow schedule list` shows a `last_tick` from the last minute.
3. Suspend the host across a scheduled run of a test workflow for ten minutes, resume it, and check that the run is listed as `missed` within a minute and that one back-online notice appears in the audit (`grep runner.back_online <home>/audit/audit.jsonl`).
4. Remove it with the command `taskfollow schedule remove` prints. Tell Claude what you saw.
### 19. Skills Wiki side: serve each pack's commit_sha (only if you want installs to record it)

**Why:** installs pin each skill file by its text (D107), because Skills Wiki's MCP answers do not say which version they are: `skill_pack_meta.commit_sha` is only read by its own scripts. If `get_skill_resource` (or a small tool of its own) also returned the pack's `commit_sha`, installs could record it next to the content pin, and the shadow upgrade's message could name the commit.

1. In the Skills Wiki repository, add the pack's `commit_sha` from `fetch_skill_pack_meta` to the `get_skill_resource` answer (for example a `commit_sha` field next to `path`, `kind` and `content`).
2. Tell Claude when it is live; the installer then records it with each pin (a small change, left for later in D111).

## Done

- 2026-10-08: Plan 1 live test (14 of 14 passed).
- 2026-10-08: Dev keys file filled in and verified (Skills Wiki, Google Sheets, Telegram, Zoho email).
- 2026-10-08: Google token scope: Google grants Drive along with Sheets; you chose to keep it. Claude calls only the Google Sheets API (`sheets.googleapis.com`); any other Google service needs your confirmation first.
- 2026-10-12: Setup tasks 5 (Google OAuth client, as a Desktop app; its shared-app decision stays open), 7 (Telegram bot) and 8 (mailbox) done; the dev keys file was checked (the Telegram chat ID had held a URL and was corrected).
- 2026-10-12: Task 17, Codex terms read by you: `tos_review: ok` (D121). Antigravity stays out of automated use (D114).
- 2026-10-12: Live guides for Plans 2 to 9 (tasks 2, 3, 4, 6, 9, 10, 11, 12) all passed and are recorded in each guide on its own branch. Findings fixed: the hosted Skills Wiki answers a wrong key with 403 (treated as a rejected key), a stale invite date in a gateway unit test. Open for review: undeliverable approval announcements are retried every minute (audit noise), and the host readiness score ignores checks it cannot read.
- 2026-10-15: Task 25, task steps with the real Claude Code (2.1.300) and the Shopify CLI (4.9.4), on the live store `pockase-inc.myshopify.com`, all runs `--sandbox` and read only, in a throwaway home. **Bug found and fixed:** with `--json-schema`, Claude Code returns the answer through its own `StructuredOutput` tool, which the task hook refused (not in `may_use`), so every task step with an output failed with "The agent did not answer with JSON". Fix `b2e6c49` on `feat/agent-tasks` (#31): the hook always allows `StructuredOutput` and does not record it (the answer is the step's output, not a call); merged forward through #32–#37 and pushed (`feat/whatsapp` at `fc6319b`). Results: (1) passed after the fix: the step answered order #1022 with date, status and total; (2) passed: `why` shows the call with Claude's reason, and also a live refusal (the agent's first command added `2>&1`, the hook refused it, Claude Code obeyed and the agent retried without it); (3) covered by evidence, not run against the live store: item 2 proves Claude Code obeys the hook's deny, unit tests cover the `--allow-mutations` refusal, and the store token has only `read_orders`; (4) passed: the claude.ai Shopify connector (`mcp__claude_ai_Shopify__get-shop-info`) loads and is gated and recorded inside a `--restricted` run; (5) passed: no transcript in `~/.claude/projects` for task runs (the install's probe step does save one, expected: it tests resume). Also learned: `shopify store auth` is a separate sign-in from the CLI's normal login (without it: "No stored app authentication found for <store>"; the agent reported it in plain words and did not look for another way); the standalone `probe` command does not save the agent, only the install's `preflight.probe` step does, so a test home needs that step. Open, minor: the record's masking turns `sortKey: CREATED_AT` into `sortKey: [masked]` ("key" matches the secret pattern); `tests/unit/slack-socket.test.ts` "finds what an earlier run saved but did not finish" sometimes times out at 3 s under load (seen 2 of 10 runs, unrelated to this fix).
- 2026-10-12: Task 14, Claude Code certified on macOS (Intel) at commit `437692c`, Claude Code 2.1.296: 1,360 offline and 18 live tests passed (README table updated). First run was Compatible only because the Google refresh token had been revoked when the app's access was removed after the Plan 5 guide; keep the app's access until certification is done, and reload the dev keys file in the terminal after changing it.
