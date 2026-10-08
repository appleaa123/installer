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

## Optional

### 3. Check Antigravity's terms (only if you want `agy` as an automatic model fallback)

**Why:** decision D32 records that Antigravity's terms (clause 6) forbid other programs from invoking it, so the installer never calls `agy` automatically. If the current terms allow it, Claude can add it.

1. Read Antigravity's current terms of service and find the section on automated or third-party use.
2. Tell Claude what it says. Claude will record the outcome as a decision.

## Done

- 2026-10-08: Plan 1 live test (14 of 14 passed).
- 2026-10-08: Dev keys file filled in and verified (Skills Wiki, Google Sheets, Telegram, Zoho email).
- 2026-10-08: Google token scope: Google grants Drive along with Sheets; you chose to keep it. Claude calls only the Google Sheets API (`sheets.googleapis.com`); any other Google service needs your confirmation first.
