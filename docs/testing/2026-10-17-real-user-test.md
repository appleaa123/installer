# Your real-user test of TaskFollow v1

Written 2026-10-17 for you, the owner. This is not a script. Use TaskFollow the way a stranger would: with only `START-HERE.md` and what TaskFollow itself tells you. When something confuses you, stops you or looks wrong, write down the exact words on the screen. That is the result we need (scope 9.11: *"install, set up, run and use TaskFollow daily on my own, without step-by-step help, without bugs"*).

The numbers in brackets, like **[37]**, are the human tasks in `docs/human-tasks.md` that your normal use also answers. You don't need to open those tasks; just notice what this guide asks you to notice, and Claude ticks them off from your notes.

## Before you start (10 minutes)

1. **Use test accounts first.** Your test Gmail for email, and **choose Google Sheets** when the install asks where you keep your contacts (a new, empty sheet is fine): lead qualification, CRM update, invoice processing, meeting follow-up and invoices due are offered only with it. Keep your real business mailbox out of it until Parts A and C have gone well.
2. **Make the package.** TaskFollow is not on npm yet, so `npx --yes taskfollow` in START-HERE won't find it. In a terminal:
   ```
   cd ~/Desktop/ML-Project/installer
   git switch main && git pull
   npm pack
   ```
   This builds and makes `taskfollow-0.1.0.tgz` in that folder. START-HERE step 2 then tells you, like any tester, to install it with `npm install -g ` and the file.
3. **A real install changes your real Claude Code.** That's the point of this test, but know what it touches: TaskFollow registers its own tools in your Claude Code (`claude mcp list` will show `installer`), and if you turn on watching, it adds a hook to `~/.claude/settings.json`. Uninstall removes what it wrote, and nothing else (Part D).

## Part A: Claude Code, as a real user (one evening to start, then a few days)

**Install.** Open a terminal, follow `START-HERE.md` from step 1 as if you had never seen this project, and give Claude Code the one sentence from step 5. Answer the helper's questions honestly for your own business. Don't paste anything from this development session.

While you install, notice:
- every place you had to guess, or needed something the page didn't say;
- the email page: does it say plainly which mailbox it will read? It should warn you if the sign-in name is not the address (the mix-up we hit in task 28);
- the join step: it should tell you the exact first line to send (`JOIN <code>` by email), not just "send the code";
- the final report: is it plain? Does the **Runs** line say when your workflows run (this laptop only while it's awake, or always on)?

**The interview.** When the helper asks you to walk it through your week, do it for real. It should propose workflows from what you said (inbox triage, lead qualification, CRM update, invoice processing, meeting follow-up, invoices due), ask which tool you use for each, and at most once say you can ask it to find your repetitive work.

**Use it for a few days.** In whatever order fits your week:

| Try this | Notice | Answers |
|---|---|---|
| Inbox triage on your test Gmail, with your own rules and two or three real past emails as examples | The daily list is right by your rules. With no Telegram, your agent tells you at the start of your next session | [37] |
| The "with replies" version: let it draft a reply to a test email that asks a question, and approve it in your own terminal | The reply arrives in the same email conversation. Nothing is sent before your yes | [37] |
| Reject one drafted reply in your own terminal, with a reason (`taskfollow approvals reject <id> --reason "too formal"`) | At your next session the agent proposes one rule in your words and adds it to that workflow's `references/my-rules.md` only after your yes; the next draft follows it | [41] |
| Send the test Gmail a new contact's message, and an email with a small PDF invoice attached (from a different address) | The lead and the invoice each wait for your yes before anything is saved or replied. The invoice's vendor, amount and due date come from the PDF | [38] [39] |
| Put a short meeting note in the install folder's `meeting-notes/` and run the meeting follow-up | One approval for all the actions; the agent read only that note | [38] [39] |
| Run "invoices due" by hand | It lists what's due within 7 days, with a total that TaskFollow added up, not the model | [39] |
| In a fresh chat, ask "find my repetitive work" (connect your test Gmail to your agent its own way, not through TaskFollow) | It asks where to look; it reads only; its list has no quotes and no names; it adds a workflow only after your yes; TaskFollow received nothing but that workflow | [40] |
| Start a new session after a scheduled run | Without asking, the agent tells you what ran since you last spoke and shows anything waiting for your approval. "Why did that happen?" gets a plain answer | rule 11 |

**One probe only a person can answer [35]:** in your Claude Code settings, add an "ask" rule for your email send tool, then run in your own terminal `taskfollow check start t6b --value '{"tool":"<your send tool>","address":"<your test address>"}'`. Did a test email arrive? What does `taskfollow check list` say for asks-first? Then once more with a "deny" rule.

**The safety line to watch for:** if anything is ever sent, paid, deleted or written to a customer without your yes, stop and tell Claude at once. That would be a blocker.

## Part B: Antigravity, in its chat (about 30 minutes) [42]

1. **First, the terms.** Read Antigravity's current terms, the clause about other programs using it (clause 6 when we read it on 2026-10-09). Tell Claude whether it still forbids that. Either way, TaskFollow never starts Antigravity on its own.
2. In a new, empty folder, open Antigravity and paste START-HERE's one sentence. Go through the setup on your own.
3. **What should work, with you in the chat:** the install questions, the email channel, approvals in your terminal, `why`, and workflows you run by asking it. Workflow skills go in `.agents/skills/` and a section in `AGENTS.md` (you may need to ask it to read `AGENTS.md`).
4. **What it should say honestly it can't do:** TaskFollow can't start Antigravity by itself, so scheduled workflows that need a model's judgment need a model key of your own (`taskfollow model`), or you run them by asking. The report's **Agent** and **Runs** lines should say this in plain words. Also note: the "connect your agent to the installer's tools" step shows as Limited, with the `taskfollow tool` way instead. That is expected.

Notice where it confused you or stopped, and copy the Agent and Runs lines.

## Part C: Claude Cowork, for work that only reads and reports

Cowork on the web has no terminal, so it can't install TaskFollow. It can run a report-only workflow on its own schedule, even with your laptop closed.

1. From your Claude Code install (Part A), choose a report-only workflow: the inbox triage list, or invoices due. Ask your agent to hand it to Cowork. It runs `taskfollow check deliver <id>`, which writes a skill zip and prints the schedule text and steps.
2. In Claude on the web: Settings, then Skills, upload the zip. Paste the schedule text into a Cowork chat. Let it run once, or wait for the next morning.
3. Notice: did the brief arrive on your phone? Was it the same as the one Claude Code made? **[33, the Cowork half]**
4. In Cowork, open a project on your install folder and ask: *"Which TaskFollow workflows do I have, and which skills does each use?"* Did it name them? **[36]**
5. If you added a rule in Part A to a workflow you delivered: run `taskfollow check deliver <id>` again, upload the new zip with the same name, and say whether Cowork replaced the old skill, refused, or kept both. **[41, step 6]**

## Part D: Safety you keep

- **Never paste a key, password or app password into any chat.** TaskFollow opens its own page on your computer for those.
- **Test accounts first** (above). Revoke each app password in your Google Account (Security, then App passwords) when you finish testing with it.
- **`taskfollow uninstall` deletes your real keychain items** (the ones named `installer`) and everything TaskFollow wrote. Run it only in an install you mean to remove. It leaves the rest of your settings alone, and keeps the home folder's audit and exports.
- If anything ever acts without your yes, stop and tell Claude: that's the one thing v1 must never do.

## Part E: When to send it to friends

Send it when all of these are true:

1. **Parts A, B and C are done, and no blocker is open.** A blocker is: the install stops and TaskFollow's own words don't get you past it, anything acts without your yes, or a workflow's result is wrong in a way its rules can't fix. Everything you noted is fixed or written down as a known limit.
2. **TaskFollow is on npm** (done 2026-10-19: `taskfollow@0.1.0`), so START-HERE's `npx --yes taskfollow instructions` works for anyone. A fix after this test means a new version: `npm version patch --no-git-tag-version` on a branch, merge, then `npm publish` from `main` (`docs/release-checklist.md` section 3).
3. **The license is in place and the repository is public.** You chose the same license as skills_wiki_opensource (Elastic License 2.0 with its added limitation, D177); `LICENSE` and `package.json` carry it, and `appleaa123/installer` is public (done 2026-10-19).
4. **Friends get two things:** `START-HERE.md`, and for at least one non-technical friend, the observer sheet in `docs/testing/2026-10-14-real-life-install-test.md` (task 23: don't help them; write down every stall).

**Tell friends what v1 deliberately doesn't do**, so they aren't surprised:
- It doesn't manage servers, firewalls or security patches, doesn't add channels beyond Telegram, email, Slack and WhatsApp, and never runs on your servers or accounts: each person runs it on their own computer and accounts (9.10, D170d).
- Their agent doesn't speak first in an open chat window yet (level 2, planned next, D170b); it tells them at their next session, or by Telegram or email if they chose one.
- Only Claude Code is proven to run unattended. Codex, OpenClaw, Hermes, Gemini CLI, Cursor and Antigravity install and work with the person in the chat; unattended runs on them are not proven (D150, D175).
- Claude Cowork can't install it; it can only run report-only workflows handed to it.

## Part F: How to report back to Claude

For each thing you noticed, paste:
- **which agent** (Claude Code, Antigravity, Cowork, or a friend's) and **which part** of this guide;
- **what TaskFollow or your agent said, word for word** (copy the text; a screenshot is fine too);
- what you expected instead, in one sentence.

Also send the report (`taskfollow report`) after the install, and say in a sentence or two **whether it felt worth it**. Claude turns each note into a fix, test-first, or records it as a known limit, then ticks off the bracketed task numbers.
