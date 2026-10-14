# Plan 6 live test guide (gateway + Telegram and email channels)

Use this guide to check Plan 6 by hand on your own machine, against the real Telegram Bot API and your real test
mailbox (human tasks 7 and 8). Each test gives the commands to run, what you should see, and a place to record what
you actually saw. If a result differs, collect the items in **Diagnostics to capture** at the end of the
[Plan 1 guide](2026-10-07-plan-1-live-test.md#diagnostics-to-capture).

The **Expected** lines below are what the plan predicts; they were not yet produced by running the commands. The
first person to run this guide replaces them with the actual output.

**This guide sends real messages, only to you:** Telegram messages from your test bot to your own chat with it, an
email from your test mailbox to itself, and in Test 7 one email to another mailbox of yours. Nothing is sent to anyone
else.

## What this build can and cannot do

Plan 6 adds: `taskpilot channel telegram | email`, `taskpilot invite <name>`, `taskpilot members`, `taskpilot gateway
start | stop | status`, the tools `channel.list | inbox | notify | send`, reply codes `A<id>`, `R<id> <reason>`,
`E<id> <new text>` in Telegram, opt-out (STOP), a recipe's consent policy, and `taskpilot disconnect telegram |
email`. Until an install is finished, every message is recorded under `sandbox/outbox/` instead of being sent. The
gateway is a background process you start yourself; it does not start at boot yet (Plan 9). It calls only
`api.telegram.org` and your mail provider's IMAP and SMTP servers. No webhooks, no buttons, no attachments yet.

This guide needs no Skills Wiki key and makes no Claude Code calls: you play the agent by running the commands it
would run. It uses the test solution `tests/fixtures/solution-channels.json`, whose one step finishes at once, so
messages are really sent; its consent policy needs a contact to write first, and its quiet hours are 21:00 to 08:00
(Toronto time): run Test 6 outside those hours.

## Results summary

| Test | What it checks | Pass / Fail | Notes |
|---|---|---|---|
| 0 | Setup | Pass | Commit 85fc656, Node v22.14.0 |
| 1 | The automated live tests (one Telegram message, one email to yourself) | Pass | Email passed at once; Telegram passed after `TELEGRAM_TEST_CHAT_ID` was corrected (it held a getUpdates URL, not the number) |
| 2 | Telegram: the token page and `taskpilot channel telegram` | Pass | Bot verified; token not in the config file (mode 600) |
| 3 | Email: the app password page and `taskpilot channel email` | Pass | Verified; wrong IMAP port gave `Cannot reach the mail server … (ETIMEDOUT)`, exit 2 |
| 4 | The gateway runs, and you join with an invite code | Pass | Joined as `member` (this solution records no decision maker) |
| 5 | An approval announced in Telegram and approved with a reply code | Pass | Reply code `A1` approved item 1 as Owner (role member) |
| 6 | An approved message is sent; STOP ends it | Pass | Sent once; replay refused; STOP then blocked a new request |
| 7 | A reply code by email decides nothing | Pass | JOIN needs a space; `A2` by email refused with the forged-sender text; item stayed pending |
| 8 | A killed gateway is replaced by the next start | Pass | Stale detected; new gateway replaced it and read the message sent while it was down |
| 9 | Stop, disconnect and clean up | Pass | Gateway stopped; both channels disconnected |

---

## Test 0: Setup

```bash
export T=~/installer-plan6-test
export REPO=/Users/allenliu/Desktop/ML-Project/installer
export PREFIX=$T/npm
mkdir -p $T $PREFIX

node --version            # must be v22 or later
cd $REPO && git log --oneline -1

npm install && npm run build && npm pack --pack-destination $T
npm install -g --prefix $PREFIX $T/taskpilot-0.1.0.tgz
export PATH=$PREFIX/bin:$PATH
which taskpilot
export INSTALLER_HOME=$T/home
taskpilot start --solution file:$REPO/tests/fixtures/solution-channels.json
taskpilot next
cd $T
```

**Expected:** `which taskpilot` prints `<your home>/installer-plan6-test/npm/bin/taskpilot`; `taskpilot next` prints
`"status":"complete"`.

**Record:**
- Commit shown by `git log`: 85fc656 (fix(core): release the audit lock under the guard)
- Pass / Fail: Pass (2026-10-12)

---

## Test 1: The automated live tests

They need `TELEGRAM_BOT_TOKEN`, `TELEGRAM_TEST_CHAT_ID` and the ten `TEST_EMAIL_…` names (tasks 7 and 8). The
Telegram test calls `getMe` and sends ONE message to your test chat; the email test signs in to IMAP read-only and
sends ONE email from your test mailbox to itself.

```bash
cd $REPO
set -a; . ~/.config/installer-dev/.env; set +a
npm run test:live -- tests/live/telegram.live.test.ts tests/live/email.live.test.ts
cd $T
```

**Expected:** `Test Files  2 passed (2)` and `Tests  4 passed (4)`; a message `installer live test … (Plan 6)` in your
Telegram chat with the bot, and an email `installer live test …` in your test mailbox.

**Record:**
- Pass / Fail: Pass (email 2 of 2 at once; Telegram needed `TELEGRAM_TEST_CHAT_ID` to be the plain number: it had held a URL and gave `chat not found`)

---

## Test 2: Telegram

```bash
taskpilot secret telegram
```

A page opens in your browser. Paste the bot token there and press **Save**.

```bash
taskpilot channel telegram
taskpilot channel
```

**Expected:** the first prints `{"status":"verified","channel":"telegram",…,"bot":"@<your bot's username>",…}`; the
second lists it with `"capabilities":{"buttons":false,…,"inbound":"long_poll"}` and
`"risk":{…,"sender_verified":true}`. The file `$INSTALLER_HOME/config/channels/telegram.json` does not contain the token
(`grep -c : $INSTALLER_HOME/config/channels/telegram.json` shows the file; search it for the first digits of your token
and find nothing).

**Record:**
- Pass / Fail: Pass (`@SA_AI_AGT_bot` verified; the config file has mode 600 and no token)

---

## Test 3: Email

```bash
taskpilot secret email
```

A page opens. Enter the app password and press **Save**. Then, with your own address:

```bash
taskpilot channel email --value '{"address":"<your test address>","imap":{"host":"imap.zohocloud.ca","port":993,"security":"ssl"},"smtp":{"host":"smtp.zohocloud.ca","port":465,"security":"ssl"}}'
```

**Expected:** `{"status":"verified","channel":"email",…,"address":"<your test address>",…}`. No email is sent by this
command. Run it once more with a wrong port (`"port":994` for IMAP): it exits 2 with `Cannot reach the mail server …`.

**Record:**
- Pass / Fail: Pass (verified; `Cannot reach the mail server imap.zohocloud.ca:994 (ETIMEDOUT)`, exit 2 for the wrong port)

---

## Test 4: The gateway, and joining

Type the invite yourself, in this terminal:

```bash
taskpilot invite Owner
taskpilot gateway start
taskpilot gateway status
```

**Expected:** the invite prints a `code` like `ABCDE-FGHJK` and a `join` line with `https://t.me/<bot>?start=…`; the
gateway prints `{"status":"started","pid":…}`; the status says `"running"`. Open the `t.me` link on your phone and
press **Start** (or send `/join <code>` to the bot). Within a few seconds:

```bash
taskpilot members
```

**Expected:** member 1, `Owner`, `"status":"joined"` and `"role":"member"` (this test solution has no `mode.decision-maker` step, so nobody is the decision maker; an install that recorded `Owner` as its decision maker would show `"role":"decision_maker"`). The bot writes `Welcome, Owner: you
joined as a member. …` (the install is finished, so it is sent). Sending the same code again gets no answer
and `taskpilot members` still shows one member.

**Record:**
- Pass / Fail: Pass (invite, gateway start and status as expected; joined as `member`; a repeated code is redacted to `(join code)` and gets no answer)

---

## Test 5: An approval in Telegram

Write any message to the bot first (for example `hello`), so the consent policy allows a reply to you. Then ask, as
the agent would:

```bash
taskpilot tool channel.inbox '{"limit":1}'
taskpilot tool approvals.request '{"tool":"channel.send","args":{"channel":"telegram","to":"<your chat id>","text":"Live test: approved from Telegram"},"why":"Plan 6 live test."}'
```

**Expected:** the inbox shows your message with `"untrusted":true`, `"route":"conversation"` and the warning note; the
request answers with item `id` 1, `"level":"L2"`. Within a few seconds the bot writes `Approval 1 (L2): channel.send …
Reply A1 to approve, R1 <reason> to reject, or E1 <new text> to change the text. …`. Answer `A1` in Telegram.

**Expected:** the bot answers `Approval 1 is approved.`; `taskpilot approvals list` shows item 1 `"approved"` with
`"decision":{"by":"Owner","role":"member",…}` (`decision_maker` only when the install recorded Owner as its decision maker).

**Record:**
- Pass / Fail: Pass (reply code A1 approved item 1; the announcement waits for you to have written first)

---

## Test 6: The approved message, then STOP

```bash
taskpilot tool approvals.get '{"id":1}'
taskpilot tool channel.send '{"channel":"telegram","to":"<your chat id>","text":"Live test: approved from Telegram","approval_token":"<the token>"}'
```

**Expected:** `{"channel":"telegram","to":"<your chat id>","status":"sent"}` and the message arrives. The same command
again exits 2 (`was already used`). Now send `STOP` to the bot and ask for a second message as in Test 5.

**Expected:** the request is refused at once, and no item is made: `<your chat id> opted out of messages on telegram
(do-not-contact)`.
(To be contacted again, remove the newest file under `$INSTALLER_HOME/data/channels/opt-outs/`; v1 has no command for
it.) Between 21:00 and 08:00 Toronto time, the send is refused with `It is quiet hours …` and works later with the same
token.

**Record:**
- Pass / Fail: Pass (sent once; replay `Approval 1 was already used`; after STOP: `opted out of messages on telegram (do-not-contact)`)

---

## Test 7: Email does not decide

```bash
taskpilot invite "Owner (email)"
```

From another mailbox of yours (not the test address itself: the gateway ignores mail from its own address), email
the test address with the first line `JOIN <code>` (with a space after `JOIN`: `JOINABCDE-FGHJK` is not recognized and is stored as an ordinary message) and wait about a minute.

**Expected:** `taskpilot members` shows member 2 joined on `email`. Then ask for an approval of an internal change:

```bash
taskpilot tool memo.add '{"text":"Draft"}'
taskpilot tool approvals.request '{"tool":"memo.edit","args":{"id":1,"text":"Final"},"why":"Plan 6 live test."}'
```

It answers with item `id` 2; nothing is announced by email. Email `A2` from your other mailbox. Within about a minute
that mailbox gets an answer: `Approvals cannot be decided by email, because the sender of a message there can be
forged: answer in Telegram, or run 'taskpilot approvals approve 2' in a terminal`; `taskpilot approvals list` still shows item 2 `"pending"`. Decide it in this terminal with `installer
approvals approve 2 --as Owner`.

**Record:**
- Pass / Fail: Pass (the first mail with `JOINX45HL-NYXXC`, no space, did not join; with a space it did; `A2` by email: the forged-sender reply, item still pending until approved in the terminal). Observation F3: a pending item whose only decider is unreachable (opted out) is re-tried every minute, one audit line each

---

## Test 8: A killed gateway

```bash
taskpilot gateway status
kill -9 <the pid it shows>
taskpilot gateway status
taskpilot gateway start
```

**Expected:** the second status is `{"status":"stale",…,"note":"The gateway stopped without cleaning up …"}`; the start
prints `"status":"started"` with a new pid and `"note":"Replaced a gateway that had stopped without cleaning up
(pid …)"`. Messages you sent to the bot while it was down are read now (Telegram keeps them for 24 hours).

**Record:**
- Pass / Fail: Pass (`stale` after kill -9; start replaced pid 46060 with 57862; the message sent while down was read within a second)

---

## Test 9: Stop, disconnect and clean up

```bash
taskpilot gateway stop
taskpilot disconnect telegram
taskpilot disconnect email
rm -rf $INSTALLER_HOME
```

**Expected:** `{"status":"stopped","pid":…}`, then two `{"status":"disconnected",…}` answers with what to revoke at
the provider. If you want the test bot gone too, send `/deletebot` to @BotFather; delete the app password at Zoho if
you made one only for this test.

**Record:**
- Pass / Fail: Pass (stopped; both channels disconnected with `secret_deleted:true`)
