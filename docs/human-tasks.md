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

### 27. Try WhatsApp with a real business number (before WhatsApp is promised to a client)

**Why:** WhatsApp (D149) was built against a fake Meta and a fake Cloudflare. About an hour, with Meta's free test number first. Tell Claude what happens at each step, with exact wording of anything unexpected.

1. Make a free Cloudflare account and a Meta developer app (type Business) with WhatsApp added. Run `taskfollow secret whatsapp` and follow step 1: does the token with the three listed permissions work? Does a brand-new account get a workers.dev address?
2. Step 2: paste the callback address and verify token into Meta's webhook settings; does Meta accept them at once? Subscribe to `messages`. Make a system user token: which permissions did Meta ask for, and does it say it never expires?
3. Step 3: add your own number to the test number's allowed list, send a message, press Check: Connected?
4. `taskfollow channel whatsapp`, then send another message and check `channel.inbox`.
5. Ask Claude to send you a reply through an approval: it should arrive. Then wait more than 24 hours after your last message and try again: it must be refused before anything is asked.
6. If you can, have someone with a WhatsApp username (no visible number) write: does the message arrive, and does a reply reach them?
7. Note whether Meta asked you to switch the app to Live, and what it required.

### 33. Your morning email brief, end to end, on Claude Code and on Claude Cowork (item 4, D160)

**Why:** this is the doability check on your own example, *"check my email every morning and send me a brief"*, and the test of the whole idea (spec section 11): if it does not feel worth it to you as user 1, we learn it here. About 60 to 90 minutes, mostly waiting; your test Gmail and its app password (you enter it only on TaskFollow's own page); Claude Cowork on the web. Nothing is sent to anyone but you. Every command is one short line: `bash ~/Desktop/ML-Project/installer/docs/testing/task33-steps.sh <step>`. Tell Claude what each step printed or showed, with the exact words of anything unexpected.

**Before you start:** TaskFollow's email channel ignores mail sent from its own address. For Home 1, send your test emails **from a different address** (your phone's other account, or a friend) to the test Gmail.

**Home 1, TaskFollow's runner on this computer**
1. `setup`: builds, starts a throwaway install in `~/taskfollow-task33` and answers its questions (on your own; no Telegram; email yes). Paste back the checksum line.
2. `email`: a page opens: enter the test Gmail address and its app password there. When it says Connected, run `channel`, then `gateway`.
3. Send two or three short test emails to the test Gmail from another address. Then `workflow` (adds the morning brief), and `describe`: on the page that opens, answer **No** to both questions (it sends nothing to anyone but you, and changes nothing).
4. `once`: it runs the brief once, safely, and shows the result; a page asks whether you saw it and whether it was right. Answer there.
5. `t7`: TaskFollow runs a test task through its own runner. Then `home1`: it says where the brief would run and why, shows your summary page, and runs the brief once by hand with `why`. Paste back what `home1` printed.

**Home 2, Claude Cowork's own schedule**
6. `t8`: a page opens with three steps: upload the test skill (Settings, then Skills), paste the instruction into a **Cowork** chat, and tick when you see the task in its list. Then close the Cowork tab and tick **I closed the window**; TaskFollow sends the test email to your own address (or the page gives you a subject to send from your phone). At the set time a push arrives on the Claude app; type the subject and the check word on the page, and say when it arrived.
7. `deliver`: it writes the brief as a skill zip and prints the schedule text and steps. Upload the zip in Settings, then Skills, paste the schedule text into a Cowork chat, and let it send you a real brief (you can ask Cowork to run it once now, or wait for the next morning).
8. `home2`: your summary page for Cowork. Paste it back, and say in one or two sentences **whether this felt worth it**, and what felt wrong or slow.

**Clean up:** `clean` (stops the gateway, removes TaskFollow's registration from Claude Code, prints the settings checksum, which must equal step 1's). In Claude, delete the scheduled tasks for this test, and the skills `taskfollow-check-…` and `morning-brief` (Settings, then Skills); Cowork cannot delete them from a chat. Never run `taskfollow uninstall` here.

**Paste back:** the two checksum lines; what `home1` and `home2` printed; the T8 page's last screen; anything unexpected, word for word; your verdict.

### 35. Does your Claude Code report a blocked send when nobody is there to ask? (item 7a, T6b, about 15 minutes)

**Why:** T6b (D162) counts "your agent asks before sending" as tested only when Claude Code's own output lists the send as denied. Claude Code's headless docs say `claude -p --output-format json --permission-prompts none` lists denials in `permission_denials`; this has not been seen on your Claude Code yet, so T6b's yes is marked unconfirmed until this task. Use your test Gmail; nothing reaches anyone else.

1. In your own terminal (not through your assistant), with an ask or deny rule for your email send tool in your Claude Code settings: `taskfollow check start t6b --value '{"tool":"<the tool, for example mcp__claude_ai_Gmail__send_email>","address":"<your test address>"}'`.
2. Wait two minutes; answer on the page that opens whether a test email arrived.
3. Tell Claude what `taskfollow check list` shows for asks-first, and whether the email arrived.
4. Then once more with a `permissions.deny` rule instead of an ask rule: is the denial still listed (the result says yes, tested) or not (not checked)?

### 36. Does Claude Cowork read the install folder's CLAUDE.md? (D156 assumption, the final session, about 5 minutes)

**Why:** D156 recorded your expectation that Claude Cowork reads a project's `CLAUDE.md` the way Claude Code does; the official documents do not say. TaskFollow writes the list of your workflows there (D154), so whether Cowork sees it decides whether Cowork knows your workflows in chat.

1. In Claude Cowork, open a project on the install folder (the folder with TaskFollow's section in `CLAUDE.md`).
2. Ask: *"Which TaskFollow workflows do I have, and which skills does each use?"*
3. Tell Claude whether the answer names your workflows (it read the section) or not. If not, the fallback is to paste the same section into the Cowork project's standing instructions.

## Optional

### 28. Approve one product change, then let Claude Code make it (before approve-then-publish is promised to a client)

**Why:** an approved call to the agent's own tool (D151) was built against a fake agent. About 20 minutes on this Mac, with your test store and the claude.ai Shopify connector, in a fresh test home, with your real Claude Code (2.1.295 or later). Pick a product you don't mind changing. Tell Claude what happens at each step, with the exact wording of anything that surprises you.

1. Ask Claude to set up a test home and add the "product change" example from INSTALL.md §9b with your connector's real tool names (Claude finds them with you), then to start a run as if a team member asked: "Change the description of <product> to: <new text>".
2. The run should wait on an approval. `taskfollow approvals list`: the item shows the exact call (tool and every argument). Check the new text is what you want.
3. Approve it in your own terminal: `taskfollow approvals approve <id> --as "<your name>"`, then let the run continue (Claude tells you the command). Expect the run to complete.
4. Open the product in your Shopify admin: the description must be exactly the approved text, nothing else changed.
5. `taskfollow why --run <run id>`: the approval and the one call should be there. Claude also compares the record with the approved arguments (does Claude Code pass them exactly as written?), and, with a temporary debug hook in a scratch folder, captures what Claude Code sends after a failing MCP call (for example updating a product id that does not exist): TaskFollow assumes an error arrives as `isError: true`.
6. A refused attempt on the real thing: Claude makes a temporary copy of TaskFollow in a scratch folder (never committed) whose instruction to the agent asks for a slightly different text, and runs one more approved call with it. The call must be refused and the step fail with "did not make the approved call". Your store must be unchanged by this run.
7. Tell Claude whether Claude Code accepted the hook settings without complaint (`onFailure: "block"`, new in 2.1.295).

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

- 2026-10-16: Task 34, run by Claude on your Mac (Claude Code 2.1.301), the runner test T7 of item 4a (D159), in a throwaway install. `taskfollow check start t7` ran one real task through TaskFollow's runner allowed only `check.ping`: **passed** ("TaskFollow ran a real task through its runner and saw the test call under its hook"); the step's call record shows the agent's reason, then `mcp__installer__check_ping` with outcome ok; `check list` shows runner and tools "yes, tested". Clean-up: `installer` MCP entry removed by hand, `~/.claude/settings.json` byte-identical, only the install probe's transcript folder under `~/.claude/projects/` (expected), removed; no task-run transcript.
- 2026-10-16: Task 32, the Cowork spike (item 4), on your Claude Cowork on the web with your test Gmail; result in D158. (2) A skill gets in by **uploading a zip whose single folder has `SKILL.md` at its top** (no plugin manifest; a zip with `.claude-plugin/plugin.json` and `skills/<name>/SKILL.md` was refused: "A skill cannot contain a plugin manifest… SKILL.md file must be in the top-level folder"; plugins upload separately). The uploaded skill **synced to your account and appeared in Claude Code too** (as `anthropic-skills:taskfollow-check`). (3) Cowork used it in chat (answered the check word). (4) Through the Gmail connector it found the planted `TASKFOLLOW-CHECK spike` email. (5) A one-time scheduled task set by Cowork for 10:04 PM ran **on time in the cloud with the browser tab closed**, read the newer email sent after it was set, loaded the skill (its run log in the Scheduled tab: "Loaded tools gmail search messages", "Loaded a skill taskfollow-check", "SendUserMessage"), and delivered the brief **as a Cowork message with a push notification on the Claude phone app**, not by email. Cowork set the run's permissions to **"Automatically approve"** by itself. Seen: the second subject lacked the four letters you meant to add (the real check gives the exact word). (6) Clean-up must be done by hand in the app: Cowork could not delete the scheduled task from the chat it started (deleting a task also deletes its sessions) and cannot remove an account skill (sessions hold a read-only copy); you removed both on the Claude website.
- 2026-10-16: Task 31, run by Claude on your Mac (Claude Code 2.1.301), build item 3 (D155), in a throwaway folder. (1) `start --solution starter`, then the answers of a person on their own with no channel (me, Owner, always-on no, no contact list, no Telegram, no email, no Slack, no WhatsApp): after the last answer the install went straight to "Choose your workflows", with no Telegram, gateway or join step. (2) `report`: starter 1.9.0; "💬 Told: In your agent's chat, the next time you talk to it" with the not-checked Channels note dated 2026-10-16 and the option to add Telegram; "🕒 Runs: on this computer while it is on and awake… They use your own Claude plan"; Telegram offered under Can add. (3) An agentic workflow added from plain words and run through your real Claude Code: `why` listed the run with its result ("No saved memos to summarize: memo.list returned an empty list.") and `no_channel: true`. Clean-up: `installer` MCP entry removed by hand, `~/.claude/settings.json` byte-identical, no task-run transcript. Found: the agent step's headless calls left a transcript folder (`…-home-runtime-judge`, about 300 KB) because judge and agent calls run without `--no-session-persistence`; removed, recorded in D155, not changed here. Left for the final human session: your agent telling you at the start of a real chat what ran and what waits for you (operator rule 11).
- 2026-10-15: Task 30, run by Claude on your Mac (Claude Code 2.1.301), build item 2 (D154), in a throwaway install folder `~/taskfollow-task30` with a one-line test skill. (1) `taskfollow skills` listed the install folder's `check-word` first, then your own 19 skills, names and descriptions only (no body text). (2) `workflow add item2` with that skill and `my_rules` wrote `.claude/skills/item2/SKILL.md`, `references/my-rules.md` and a `CLAUDE.md` with only the TaskFollow section, and named both skills in the workflow. (3) `taskfollow run item2 --sandbox` through your real restricted Claude Code answered `check: PELICAN-7342` (the skill) and `rules: OSPREY-6627` (`my-rules.md`); the agent's recorded reason: "both taken from the owner's skills"; no call refused. (4) A normal `claude -p --tools ""` in the install folder answered "one TaskFollow workflow, item2 … uses the skills item2 and check-word": it read the `CLAUDE.md` section. Clean-up: `installer` MCP entry removed by hand, `~/.claude/settings.json` byte-identical, the two expected folders under `~/.claude/projects/` (the folder's, empty; the probe's) removed, no task-run transcript. Left for the final human session: opening Claude Code yourself in the install folder and asking about your workflows in a real chat.
- 2026-10-15: Task 29, the skill-loading spike (9.12 item 1), on your real Claude Code (2.1.301) in a throwaway folder with a one-line test skill, read-only; result in D153. (1) passed: a normal print-mode run lists the folder's skill with your own and plugin skills and loads it through a real `Skill` call. (2) **failed, the answer:** with `--restricted` the model sees only Claude Code's built-in skills; it found the check word by Grep and Read of the file, not as a skill, and a real task run has no file tools. (6) a `/taskfollow-spike` prompt prefix is not recognised under `--restricted`. (7) `--add-dir` gives file access but no skills; an unrelated folder and a deep subfolder show the same built-in list. Steps 3–5, 8 and 9 were skipped: each adds restriction on top of step 2. So TaskFollow puts the workflow's skill text into the task prompt (9.5's fallback). Clean-up: `~/.claude/settings.json` byte-identical; no MCP entry or skill left; Claude Code had made an empty `memory` folder under `~/.claude/projects/` for the test folder despite `--no-session-persistence` (no transcript), removed. Lessons: long pasted commands wrap inside quotes in your terminal, so test steps now live in a script (`docs/testing/task29-spike.sh`); never run `taskfollow uninstall` in a test home, it deletes your real keychain items.
- 2026-10-08: Plan 1 live test (14 of 14 passed).
- 2026-10-08: Dev keys file filled in and verified (Skills Wiki, Google Sheets, Telegram, Zoho email).
- 2026-10-08: Google token scope: Google grants Drive along with Sheets; you chose to keep it. Claude calls only the Google Sheets API (`sheets.googleapis.com`); any other Google service needs your confirmation first.
- 2026-10-12: Setup tasks 5 (Google OAuth client, as a Desktop app; its shared-app decision stays open), 7 (Telegram bot) and 8 (mailbox) done; the dev keys file was checked (the Telegram chat ID had held a URL and was corrected).
- 2026-10-12: Task 17, Codex terms read by you: `tos_review: ok` (D121). Antigravity stays out of automated use (D114).
- 2026-10-12: Live guides for Plans 2 to 9 (tasks 2, 3, 4, 6, 9, 10, 11, 12) all passed and are recorded in each guide on its own branch. Findings fixed: the hosted Skills Wiki answers a wrong key with 403 (treated as a rejected key), a stale invite date in a gateway unit test. Open for review: undeliverable approval announcements are retried every minute (audit noise), and the host readiness score ignores checks it cannot read.
- 2026-10-15: Task 26, watching and always-ask with your real Claude Code (2.1.300) settings, in a test home `~/taskfollow-task26`, all reads. (1) passed: `watch on` added exactly one `hooks.PostToolUse` entry and changed nothing else, with a backup first and the file's mode kept. (2) passed after a retry: the first session used the claude.ai Shopify connector instead of the CLI, so nothing was recorded (not a bug: only `cli:shopify` was watched); when asked for the CLI, `why direct` showed `Bash (shopify store execute)` with no query, store or flags. (3) passed: `mcp:claude_ai_Shopify` recorded `mcp__claude_ai_Shopify__get-shop-info` with only argument names (none for that tool). Record folder and file are private (0700/0600). (4) no noticeable slowdown. (5) passed: after `watch off` the settings file was byte-identical to before. (6) passed: an ask rule makes Claude Code ask even in auto mode ("Ask rule … overrides auto mode for this command"), and **it still asks when an allow rule for the same command exists** (allow in `settings.local.json`, ask in `settings.json`), which answers D147's open question; after `unask` the settings file was byte-identical to before. Fixed from this task on `feat/codex`: `unask` said Claude Code "now asks" (wrong); removing the last ask rule left an empty `permissions: {}`. Seen, by design (D146): a joined command records its first three words (`shopify version; shopify`); commands that do not start with a watched tool (e.g. reading the CLI's saved login) are not recorded; without TaskFollow's reason tool registered, every direct call shows "the agent gave no reason". Lesson: running `taskfollow start` in a test home registers TaskFollow's tools with the real Claude Code at user scope (the starter's first steps run at once); Claude removed the leftover `installer` entry.
- 2026-10-15: Task 25, task steps with the real Claude Code (2.1.300) and the Shopify CLI (4.9.4), on the live store `pockase-inc.myshopify.com`, all runs `--sandbox` and read only, in a throwaway home. **Bug found and fixed:** with `--json-schema`, Claude Code returns the answer through its own `StructuredOutput` tool, which the task hook refused (not in `may_use`), so every task step with an output failed with "The agent did not answer with JSON". Fix `b2e6c49` on `feat/agent-tasks` (#31): the hook always allows `StructuredOutput` and does not record it (the answer is the step's output, not a call); merged forward through #32–#37 and pushed (`feat/whatsapp` at `fc6319b`). Results: (1) passed after the fix: the step answered order #1022 with date, status and total; (2) passed: `why` shows the call with Claude's reason, and also a live refusal (the agent's first command added `2>&1`, the hook refused it, Claude Code obeyed and the agent retried without it); (3) covered by evidence, not run against the live store: item 2 proves Claude Code obeys the hook's deny, unit tests cover the `--allow-mutations` refusal, and the store token has only `read_orders`; (4) passed: the claude.ai Shopify connector (`mcp__claude_ai_Shopify__get-shop-info`) loads and is gated and recorded inside a `--restricted` run; (5) passed: no transcript in `~/.claude/projects` for task runs (the install's probe step does save one, expected: it tests resume). Also learned: `shopify store auth` is a separate sign-in from the CLI's normal login (without it: "No stored app authentication found for <store>"; the agent reported it in plain words and did not look for another way); the standalone `probe` command does not save the agent, only the install's `preflight.probe` step does, so a test home needs that step. Open, minor: the record's masking turns `sortKey: CREATED_AT` into `sortKey: [masked]` ("key" matches the secret pattern); `tests/unit/slack-socket.test.ts` "finds what an earlier run saved but did not finish" sometimes times out at 3 s under load (seen 2 of 10 runs, unrelated to this fix).
- 2026-10-12: Task 14, Claude Code certified on macOS (Intel) at commit `437692c`, Claude Code 2.1.296: 1,360 offline and 18 live tests passed (README table updated). First run was Compatible only because the Google refresh token had been revoked when the app's access was removed after the Plan 5 guide; keep the app's access until certification is done, and reload the dev keys file in the terminal after changing it.
