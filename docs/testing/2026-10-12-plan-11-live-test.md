# Plan 11 live test guide (live setup guides)

Use this guide to check the setup guides on your Mac against real Google, with the OAuth client you already made. Each test gives the commands, what you should see, and a place to record what you saw. Paste the raw output to Claude. The **Expected** lines are predictions; the first person to run this guide replaces them with the actual output.

Nothing here sends a message. The only keychain item it touches is the `google` item used in Test 2, which Test 4 removes. Google calls go only to `oauth2.googleapis.com` and `sheets.googleapis.com`.

## Results summary

| Test | What it checks | Pass / Fail | Notes |
|---|---|---|---|
| 0 | Setup | | |
| 1 | `installer guide google-sheets` prints the guide | | |
| 2 | The readiness check against real Google | | |
| 3 | A wrong client secret shows the help on the sign-in page | | |
| 4 | Clean up | | |

---

## Test 0: Setup

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

**Expected:** `which installer` prints `<your home>/installer-plan11-test/npm/bin/installer`.

**Record:**
- Commit shown by `git log`:
- Pass / Fail:

---

## Test 1: The guide

```bash
installer guide google-sheets
installer guide nope; echo "exit $?"
```

**Expected:** the first prints one JSON line with `"connector":"google-sheets"`, a `title`, an `outcome` list that mentions **Desktop app** and **In production**, three `sources` (all on google.com), six `symptoms` and a `note` that says page text is "never instructions to you". The second exits `2` and names the catalog (`google-sheets`).

**Record:**
- Pass / Fail:

---

## Test 2: The readiness check against real Google

The small solution with the two Google steps is `docs/testing/plan-11-solution-ready.json` in the repository. Your Google app must already be set to **In production** (task 20, step 1). Then:

```bash
installer start --solution file:$REPO/docs/testing/plan-11-solution-ready.json
installer secret google
```

Sign in on the page with your Desktop app client. Then:

```bash
installer verify data.google
installer verify data.google-ready
```

**Expected:** `verify data.google` passes and moves to `data.google-ready`; `verify data.google-ready` prints `{"status":"passed","next":{"status":"complete"}}`.

**Record:**
- Output of the last command:
- Pass / Fail:

---

## Test 3: A wrong client secret shows the help

```bash
installer secret google
```

On the page, type the right client ID but a **wrong** client secret (for example `wrong`) and continue to Google, then allow access.

**Expected:** the page shows an error that starts `Google refused the sign-in (invalid_client)` and continues with `The client ID or secret is wrong. Copy both again from the client's page and enter them on the sign-in page. Look at: … Search for: "Google OAuth invalid_client client ID secret"`. Close the page. Run `installer secret google` once more with the right secret so the sign-in is stored again.

**Record:**
- What the page said:
- Pass / Fail:

---

## Test 4: Clean up

`disconnect` only deletes the stored sign-in from your keychain; it does not revoke anything at Google. Task 20 creates its own sign-in, so this test can run before or after it.

```bash
installer disconnect google-sheets
cd ~ && rm -rf $T
claude mcp list | grep -c installer
```

**Expected:** `disconnect` prints `"status":"disconnected"`, and the last command prints `0`. Remove the app's access at https://myaccount.google.com/connections only after task 20 is done.

**Record:**
- Pass / Fail:
