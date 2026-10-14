# Your checklist for 2026-10-13 (about 45 minutes)

Do the steps in order. Paste the raw output of each command to Claude after each step; Claude records the result. Paste one command at a time. Never paste a key, token or secret into the chat.

Details behind each part: task 20 in `docs/human-tasks.md`, and `docs/testing/2026-10-12-plan-11-live-test.md` (Tests 0 to 4).

## Part A: Switch your Google test app to production (browser, 3 minutes)

1. Open https://console.cloud.google.com/ and select your test project.
2. Go to **APIs & Services > OAuth consent screen** (called **Audience** in newer consoles).
3. Change the publishing status from **Testing** to **In production** and confirm.
4. Tell Claude what the page shows. If Google asks for verification, paste the exact wording. (2026-10-14: it showed "Your app requires verification. When you have finished configuring your information, please submit your app for review." You do not need to submit; the app works In production, and the sign-in shows a "Google hasn't verified this app" screen where you choose **Advanced**, then **Go to (app name) (unsafe)**.)

Do this before any sign-in below, otherwise the new sign-in is still a Testing one.

## Part B: Install the build and read the guide (Terminal, 10 minutes)

Run each line on its own. If `feat/live-setup-guides` is checked out in another git worktree, `git switch` fails: set `REPO` to that worktree's path and leave out the `git switch`.

```bash
export T=~/installer-plan11-test
export REPO=/Users/allenliu/Desktop/ML-Project/installer
export PREFIX=$T/npm
mkdir -p $T $PREFIX
cd $REPO && git switch feat/live-setup-guides && git log --oneline -1
npm ci && npm run build && npm pack --pack-destination $T
npm install -g --prefix $PREFIX $T/installer-0.1.0.tgz
export PATH=$PREFIX/bin:$PATH
which installer
export INSTALLER_HOME=$T/home
cd $T
```

Expected: `which installer` prints `<your home>/installer-plan11-test/npm/bin/installer`. Paste the `git log` line and the `which` line.

Then:

```bash
installer guide google-sheets
installer guide nope; echo "exit $?"
```

Expected: the first prints one JSON line (title, outcome, three google.com sources, six symptoms, a note). The second exits `2` and names `google-sheets`. Paste both outputs.

## Part C: Sign in and run the readiness check (Terminal and browser, 10 minutes)

```bash
installer start --solution file:$REPO/docs/testing/plan-11-solution-ready.json
installer secret google
```

Open the page it prints, enter your Desktop app client ID and secret there (never in the chat), and allow access. Google shows "Google hasn't verified this app": choose **Advanced**, then **Go to (app name) (unsafe)**. Then:

```bash
installer verify data.google
installer verify data.google-ready
```

Expected: the last one prints `{"status":"passed","next":{"status":"complete"}}`. Paste the output of both.

## Part D: Task 20, check the sign-in no longer expires (Terminal, 5 minutes)

This uses the sign-in you just made in Part C.

1. Copy the new refresh token to the clipboard without printing it:

```bash
security find-generic-password -s installer -a google -w | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).refresh_token))' | pbcopy
```

2. Open `~/.config/installer-dev/.env` in your editor and paste the clipboard as the value of `GOOGLE_REFRESH_TOKEN`. Save. (Never paste it in the chat.) If the probe then answers `400` with `invalid_grant`, the old token is probably still in the file: check the file's save time with `ls -l`.
3. Run the probe in a subshell so the keys do not stay in your terminal:

```bash
cd $REPO && ( set -a; . ~/.config/installer-dev/.env; node docs/testing/google-token-probe.mjs )
```

4. Tell Claude whether the first line still lists `refresh_token_expires_in`. Gone means the sign-in is not marked to expire. Still there means the guide's wording must change.
5. Nothing to delete: Part F removes the keychain item.

## Part E: A wrong secret shows the help (Terminal and browser, 5 minutes)

```bash
cd $T
installer secret google
```

On the page type the right client ID and a wrong secret (for example `wrong`), continue to Google and allow access.

Afterwards `installer verify data.google-ready` is not possible (the install is already complete and has no pending step); the Part D probe is the check instead.

Expected: the page says `Google refused the sign-in (invalid_client)` followed by `The client ID or secret is wrong...` and a `Look at:` and `Search for:` line. Paste what the page says (copy the text; no secrets are shown). Close the page, then run `installer secret google` once more with the right secret.

## Part F: Clean up (Terminal, 2 minutes)

```bash
installer disconnect google-sheets
cd ~ && rm -rf $T
claude mcp list | grep -c installer
```

Expected: `"status":"disconnected"` and then `0`. Optionally remove the app's access at https://myaccount.google.com/connections, but only after Part D.

## Part G: Later

- **In 8 or more days:** run the Part D step 3 command again. A token endpoint `200` means the sign-in survived a week. Tell Claude and the date goes into D123.
- **Pull requests, when you are ready:** review #12, then #13, then #14 on GitHub. Tell Claude to merge; #12 and #14 both add rows to `DECISIONS.md`, so Claude fixes the small conflict.
- **Other open tasks** (13 team host, 15 Codex, 16 Windows, 18, 19): see `docs/human-tasks.md`; none blocks the above.
