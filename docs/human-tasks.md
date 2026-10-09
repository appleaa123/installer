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

## Optional

### 7. Check Antigravity's terms (only if you want `agy` as an automatic model fallback)

**Why:** decision D32 records that Antigravity's terms (clause 6) forbid other programs from invoking it, so the installer never calls `agy` automatically. If the current terms allow it, Claude can add it.

1. Read Antigravity's current terms of service and find the section on automated or third-party use.
2. Tell Claude what it says. Claude will record the outcome as a decision.

## Done

- 2026-10-08: Plan 1 live test (14 of 14 passed).
- 2026-10-08: Dev keys file filled in and verified (Skills Wiki, Google Sheets, Telegram, Zoho email).
- 2026-10-08: Google token scope: Google grants Drive along with Sheets; you chose to keep it. Claude calls only the Google Sheets API (`sheets.googleapis.com`); any other Google service needs your confirmation first.
