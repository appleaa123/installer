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

### 2. Run the Plan 2 live test

**Why:** the automated tests use a fake agent; this checks the real Claude Code on your machine.

1. Open `docs/testing/2026-10-08-plan-2-live-test.md`.
2. Run Tests 0 to 5 in one terminal, in order, and paste the output to Claude (as with the Plan 1 live test).
3. Test 3b needs internet and shows the real HTTP status for a missing file; Claude could not see it from its sandbox.

### 3. Run the Plan 3 live test (Skills Wiki, keychain, your real Claude Code)

**Why:** the automated tests use a fake Skills Wiki server, a file keychain and a fake agent. This checks the real ones. The guide's expected outputs are predictions: they have not been run against the real services yet.

1. Open `docs/testing/2026-10-08-plan-3-live-test.md` and follow it in one terminal, in order.
2. When a page opens in your browser, paste your Skills Wiki API key there (never into the chat or the terminal).
3. Paste each test's output to Claude. If an output differs from the guide, Claude will fix the code or the guide.
4. The guide's last test removes the Skills Wiki registration and the keychain item it created.

### 4. Run the Plan 4 live test (approvals, your real Claude Code)

**Why:** the automated tests use a fake agent and make the person's decisions in-process. This checks that your real Claude Code reaches the installer's own tools, that it cannot approve its own request, and that your approval in your own terminal lets exactly that action run once. The guide's expected outputs are predictions: they have not been run yet.

1. Open `docs/testing/2026-10-08-plan-4-live-test.md` and follow it in one terminal, in order. No Skills Wiki key is needed.
2. Type every `installer approvals …` command yourself; never let the agent run them for you.
3. Paste each test's output to Claude. Test 5 matters most: if Claude Code manages to approve its own request, stop and tell Claude.
4. The guide's last test removes the `installer` registration it created.

### 5. Create your own Google OAuth client for the Sheets connector, and decide whether to publish a shared app

**Why:** R3 says no client may depend on your Google account or OAuth app. In v1 every client creates their own OAuth client in their own Google Cloud project, and `installer secret google` signs in with it (D66). You need one too, made exactly the way a client would make it, for the Plan 5 live test. Use the Google account that owns your test spreadsheet. About 10 minutes.

1. Open https://console.cloud.google.com/ and sign in with that Google account.
2. In the project picker at the top, choose **New project**, name it (for example `installer-sheets`), press **Create**, then select the new project.
3. Open **APIs & Services → Library**, search for **Google Sheets API** and press **Enable**. Enable nothing else.
4. Open the OAuth consent screen (**APIs & Services → OAuth consent screen**; newer consoles call it **Google Auth Platform**, with the pages **Branding**, **Audience** and **Data access**). Choose user type **External** (a Google Workspace organisation can choose **Internal**, which needs no test users). Fill in the app name, the support email and the developer contact, and save.
5. On **Audience** (or **Test users**), add the Google address you will sign in with. While the app is in **Testing**, only these addresses can sign in.
6. Optional: on **Data access** (or **Scopes**), add `https://www.googleapis.com/auth/spreadsheets`. The installer asks for this scope only.
7. Open **APIs & Services → Credentials** (or **Google Auth Platform → Clients**), choose **Create credentials → OAuth client ID**, application type **Desktop app**, give it a name and press **Create**. Copy the **Client ID** and the **Client secret**. Add no redirect URI: a Desktop app client accepts the installer's own `http://127.0.0.1:<port>/` page.
8. Keep both values out of chat and out of the repository. The installer's page asks for them. For the automated live test (`npm run test:live`), put them in your own `~/.config/installer-dev/.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, next to `GOOGLE_REFRESH_TOKEN` and `GOOGLE_TEST_SHEET_ID` (check that the file uses these four names; Claude never reads it). The live guide's Test 2 shows how to copy the refresh token from your keychain.
9. Two things Claude could not check without a real sign-in; note what you see during the live guide: (a) Google accepts the loopback redirect without a registered redirect URI (if the consent page says `redirect_uri_mismatch`, check that the client type is **Desktop app**); (b) while the consent screen is in **Testing**, Google shows an "unverified app" warning and may end the refresh token after about 7 days, after which `installer secret google` has to be run again.

**Open product question (your decision):** v1 asks each client to create their own OAuth client (the steps above). The alternative is one shared app that you publish and have verified by Google: the `spreadsheets` scope is a sensitive scope, so verification needs a privacy policy, a demo video and Google's review, and takes weeks; afterwards clients only press **Allow**, with no unverified-app warning and no 7-day limit. Records would still never pass through your servers, but the grant would belong to your app, which has to be weighed against R3. The code keeps sign-in behind one interface (`AccessTokenSource`, D66), so either answer can be added later. Tell Claude one of: (1) keep client-owned apps only, (2) publish a shared verified app, (3) both, the shared app by default and the client's own app as an option.

### 6. Run the Plan 5 live test (Google Sheets with your own OAuth client)

**Why:** the automated tests use a fake Google. This checks the real sign-in page, the real Sheets API and the approval flow on a real spreadsheet. The guide's expected outputs are predictions: they have not been run yet.

1. Do task 5 first.
2. Open `docs/testing/2026-10-08-plan-5-live-test.md` and follow it in one terminal, in order. Enter the client ID and secret only on the page the installer opens, never in the chat.
3. Type every `installer approvals …` command yourself.
4. Paste each test's output to Claude. If an output differs from the guide, Claude fixes the code or the guide.
5. The guide's last test deletes the keychain item and the spreadsheet it created, and shows where to remove the app's access from your Google account.

### 7. Create a Telegram bot for each client, and one for testing

**Why:** R3 says no client may depend on your accounts, so each client's team channel is a bot that the client owns. Telegram bots are free and need no business verification (spec §12.6). You need one too, made the way a client would make it, for the Plan 6 live test; the dev keys file already has one (see Done), so for testing only check steps 3 and 4. About 5 minutes per bot.

1. In Telegram (phone or desktop), open a chat with **@BotFather** (check the blue verified tick) and send `/newbot`.
2. Give it a display name (for example `Front desk assistant`) and a username that ends in `bot` (for example `acme_desk_bot`). BotFather answers with a token like `123456789:AA…`.
3. Keep the token out of chat, email and the repository: it is the bot's password. The installer asks for it on its own page (`installer secret telegram`). For the automated live test, put it in your own `~/.config/installer-dev/.env` as `TELEGRAM_BOT_TOKEN` (Claude never reads that file).
4. Open your new bot in Telegram and press **Start**, so it may write to you. For the live test you also need your chat id: send the bot any message, then open `https://api.telegram.org/bot<token>/getUpdates` in your browser while no gateway is running and copy `message.chat.id`; put it in the env file as `TELEGRAM_TEST_CHAT_ID`.
5. For a client: the person who will own the bot (usually the decision maker) does steps 1–2 on their own Telegram account and enters the token on the installer's page during the install. If a token ever leaks, send `/revoke` to @BotFather and enter the new one with `installer secret telegram`.

### 8. Set up a mailbox for the email channel (app password, IMAP on)

**Why:** the email channel signs in to a mailbox with IMAP (to read) and SMTP (to send). Providers refuse the normal account password for that, or should: it needs an app password. Your Zoho test mailbox is already verified working with `imap.zohocloud.ca:993 ssl` and `smtp.zohocloud.ca:465 ssl` (see Done), so for testing only check step 3.

1. Zoho Mail: **Settings → Mail Accounts → IMAP Access**: tick **IMAP Access** (and keep SMTP on).
2. Zoho account: **accounts.zoho.com → Security → App Passwords** (with two-factor sign-in on): **Generate New Password**, name it `installer`, copy it once. Other providers have the same idea (Google Workspace and Gmail: two-step verification, then App passwords; Microsoft 365 needs SMTP AUTH enabled by an admin).
3. Your env file needs `TEST_EMAIL_ADDRESS`, `TEST_EMAIL_APP_PASSWORD`, `TEST_EMAIL_IMAP_HOST`, `TEST_EMAIL_IMAP_PORT`, `TEST_EMAIL_IMAP_SECURITY` (`ssl`), `TEST_EMAIL_IMAP_USER`, and the same four `TEST_EMAIL_SMTP_…` names. Check that the names match; Claude never reads the file.
4. For a client: they create the app password for the mailbox the assistant uses (a shared desk address is better than a person's own) and enter it on the installer's page (`installer secret email`); they give the agent only the address and the server names.
5. Note: an email's sender can be forged, so approvals are never decided by email (D78); a client who wants to approve from a phone needs Telegram.

### 9. Run the Plan 6 live test (Telegram and email, real messages to yourself)

**Why:** the automated tests use a fake Telegram and fake mail servers. This checks the real Bot API, your real mailbox and a gateway running on your machine. It sends real messages, only to you: Telegram messages to your own chat with your test bot, and emails from your test mailbox to itself and to one other mailbox of yours. The guide's expected outputs are predictions: they have not been run yet.

1. Do tasks 7 and 8 first.
2. Open `docs/testing/2026-10-08-plan-6-live-test.md` and follow it in one terminal, in order. Enter the bot token and the app password only on the pages the installer opens.
3. Type every `installer invite`, `installer members remove` and `installer approvals …` command yourself.
4. Paste each test's output to Claude. If an output differs from the guide, Claude fixes the code or the guide.
5. The guide's last test stops the gateway, deletes the token and the app password from the keychain and removes the test home.

### 10. Run the Plan 7 live test, and install the runner's schedule on your Mac

**Why:** the automated tests use a fake agent, a fake model server and generated scheduler files they never install. This checks one real judge call through your own Claude Code (it uses your subscription, a few small calls), and the runner's once-a-minute schedule on your own machine, including what happens when the Mac sleeps through a scheduled run (open item O14). The installer only prints the scheduler commands; you run them. The guide's expected outputs are predictions: they have not been run yet.

1. Open `docs/testing/2026-10-08-plan-7-live-test.md` and follow it in one terminal, in order.
2. Run the `launchctl` and `cp` commands that `installer schedule install` prints yourself; the guide says when.
3. For Test 6, put the Mac to sleep across a scheduled minute for at least ten minutes (close the lid, or Apple menu → Sleep), then wake it.
4. Paste each test's output to Claude. If an output differs from the guide, Claude fixes the code or the guide.
5. The guide's last test removes the LaunchAgent with the commands `installer schedule remove` prints, and deletes the test home.

## Optional

### 11. Check Antigravity's terms (only if you want `agy` as an automatic model fallback)

**Why:** decision D32 records that Antigravity's terms (clause 6) forbid other programs from invoking it, so the installer never calls `agy` automatically. If the current terms allow it, Claude can add it.

1. Read Antigravity's current terms of service and find the section on automated or third-party use.
2. Tell Claude what it says. Claude will record the outcome as a decision.

### 12. Check the crontab entry on a Linux host (only if a client will run on Linux)

**Why:** on Linux the runner's minute is a crontab line (D82). It was only checked as text on macOS.

1. On the Linux host, after `installer start`, run `installer schedule install` and run the one command it prints.
2. `crontab -l` shows a line that ends with `# com.installer.tick.<8 characters>`; after two minutes `installer schedule list` shows a `last_tick` from the last minute.
3. Suspend the host across a scheduled run of a test workflow for ten minutes, resume it, and check that the run is listed as `missed` within a minute and that one back-online notice appears in the audit (`grep runner.back_online <home>/audit/audit.jsonl`).
4. Remove it with the command `installer schedule remove` prints. Tell Claude what you saw.
## Done

- 2026-10-08: Plan 1 live test (14 of 14 passed).
- 2026-10-08: Dev keys file filled in and verified (Skills Wiki, Google Sheets, Telegram, Zoho email).
- 2026-10-08: Google token scope: Google grants Drive along with Sheets; you chose to keep it. Claude calls only the Google Sheets API (`sheets.googleapis.com`); any other Google service needs your confirmation first.
