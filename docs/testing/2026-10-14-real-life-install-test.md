# Real-life install test: can a non-technical person install TaskFollow alone?

This is the test that settles the question. Reading the code cannot: two independent reviewers found real problems that no test had caught, and fixed ones are still unproven until a person tries them. Run it twice: once on a **Mac**, once on **Windows 11**.

## What "unaided" means

The person installs TaskFollow using **only `START-HERE.md`** and their AI helper (Claude Code). The observer watches and writes things down. **The observer does not help, hint, point at the screen or answer questions about the software.** If the person is stuck for **5 minutes**, or asks the observer for help, that is an **intervention**: write it down, give the smallest possible nudge, and carry on. The test **passes only with zero interventions**. Interventions are not failures of the person; they are the list of what to fix.

## Before the day (the owner does this)

1. **Publish the package** to npm as `taskfollow` (release checklist, step 4b). Without it, START-HERE.md cannot work. For a dry run before publishing, install from the tarball and tell the person the tarball path where START-HERE.md says `npx`.
2. Choose the people: **A**, someone who has never used a terminal, on a Mac. **B**, the same on Windows 11. Not you, and not someone who has watched you build this.
3. Each person starts from a **fresh state**: a new standard user account on the computer, no Node, no Claude Code, no earlier TaskFollow (`~/.installer`, the keychain item named `installer`, `%LOCALAPPDATA%\taskfollow`).
4. Each person has, beforehand and not as part of the timing: a Claude account that can use Claude Code, a **Google account** (a personal gmail.com address; a work account is a separate, later test), and **Telegram** on their phone with an account.
5. Have a second person ready on Telegram to be the "team member" for the invite step, and a spare mailbox if you want to try email (Gmail or iCloud).
6. Screen recording on, with the person's permission. A stopwatch.

## Observer sheet

Write the clock time when each stage **starts**, and tick **done unaided**, or log an intervention.

| # | Stage | Starts | Done unaided | Interventions and stalls (what, how long, what they said) |
|---|---|---|---|---|
| 1 | Install Node (START-HERE 1) | | | |
| 2 | Open a terminal, install Claude Code, sign in (2 to 4) | | | |
| 3 | Paste the one sentence; the helper reads the instructions (5) | | | |
| 4 | Helper installs TaskFollow (`npm install -g`); on a Mac, did it say "permission denied" and did the person manage `sudo`? | | | |
| 5 | Questions about the team and the decision maker (the person types their own name) | | | |
| 6 | Google: project, Sheets API, consent screen, **publish to production**, Desktop client (the longest stage; note every screen where they hesitated) | | | |
| 7 | `taskfollow secret google`: client ID and secret entered **on the page**, "Google hasn't verified this app" passed, page says Done | | | |
| 8 | Sheet connected and columns matched | | | |
| 9 | Telegram: bot made with @BotFather, token entered **on the page** (not in the chat) | | | |
| 10 | Join the team channel; invite the second person | | | |
| 11 | Workflow added, dry run read, **confirmed in a new terminal window** | | | |
| 12 | Schedule installed (the printed `launchctl` or `schtasks` lines pasted in a new window) | | | |
| 13 | Final report says READY | | | |

Also note, at any time: any moment the person **pasted a secret into the chat**, any term they asked about ("what is a keychain?"), any message that scared them, and any time the helper ran something that the person was meant to run.

## After the install: does it really work? (the next day, not the same hour)

Run these the day after, without the person present if they agree:

1. The scheduled workflow ran at its time: `taskfollow schedule list` shows a recent `last_tick`, and a Monday run under `runs/` completed (not `missed`, not "claude is not installed").
2. **Restart the computer**, sign in, wait two minutes: `taskfollow gateway status` says running; a message sent to the Telegram bot gets a reaction.
3. An approval round trip: ask the helper for something that needs approval; approve it from Telegram (`A<id>`) or a new terminal.
4. Close the helper (Claude Code) completely and reopen it in the same folder with `claude --continue`; the helper still knows the install.
5. `taskfollow doctor` finishes with no failure the person could not act on.

## Pass / fail

- **Pass:** zero interventions across stages 1 to 13, and all five next-day checks succeed.
- **Fail with a finding:** anything else. Every intervention and every failed check becomes a fix. Fix them, then repeat with a **new** person (the first one has learned it).
- Do not average. One person who needed help once means the next person will too.

## What to send back

The filled sheet, the recording, and (from the person's computer, with their consent) the output of `taskfollow support bundle` (it contains no secrets or personal data). Also the Windows items in `docs/human-tasks.md` task 22 and the email items in task 21 if you are on those machines.
