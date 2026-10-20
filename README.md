# TaskFollow

TaskFollow turns the AI assistant you already have (Claude Code, Codex, OpenClaw, Hermes and others) into one that knows your work. It runs on your own computer, with your own assistant and your own subscription; nobody else hosts it or sees your data.

It does not change your assistant or add abilities to it. It gives it what a custom-built business agent would have: a setup done by conversation, your routine work written down as workflows, a schedule that runs them, and a person's yes before anything that matters.

**New to this? Read [`START-HERE.md`](START-HERE.md).** It takes you from nothing to a helper that sets everything up for you, click by click.

## What it does for you

- **Sets itself up by talking with you.** Your assistant asks the questions and explains each step in plain words; you never edit a config file.
- **Finds the work you repeat.** It interviews you about a normal week, or looks for what repeats, and proposes workflows: morning inbox triage, new leads, CRM notes, invoices, meeting follow-ups, or anything you describe in your own words.
- **Runs that work on a schedule**, and tells you what it found: in the chat, or on Telegram, email or Slack.
- **Tells you honestly what your assistant can do.** Before a workflow is trusted, TaskFollow tests your assistant by watching a real effect, not by taking its word. Each answer is a plain yes or no, and every no comes with what is missing and what to do instead.
- **Asks you first.** Money, legal matters, messages to customers and deletes always wait for your yes, however sure the assistant is.
- **Explains afterwards.** `taskfollow why` shows what each run did and why, and who approved what.
- **Learns from your corrections.** When you fix a result, your assistant proposes a short rule for that workflow, and adds it only after your yes.
- **Manages the skills you already have, if you want.** Setup offers [Skills Wiki](https://github.com/appleaa123/skills_wiki_opensource), free and on your computer: it moves your installed skills into one library and gives each of your assistants the right one for each request (`skillswiki release --all` puts them back). It also offers hosted Skills Wiki, a paid service with an account, for more skills and ready-made combos. Say no to both and nothing changes.
- **Lets you look first.** In consult mode it interviews you, tries your workflows once, writes a one-page report of what your assistant can do for you, and then removes what it added.

## Why not just ask your assistant?

You can tell an assistant "always ask me before you send anything". That is a request, not a guarantee: it holds only while the rule is in front of the model. In our own test, plain Claude Code kept the rule every time it was in its instructions; when a scheduled job's instructions left it out, it sent customer replies on its own in each of 3 runs, one of them answering a request to delete a person's records ([the test](docs/testing/2026-10-16-plain-agent-comparison.md)).

TaskFollow's approvals do not depend on what the instructions say. An action that needs your yes is refused until you approve that exact action in your own terminal or on your own channel, and the assistant cannot approve it for itself.

## What you need

- A **Mac**, or **Windows 11** (a Preview: not yet tried on a real PC). Linux is untested.
- **Node 22 or newer**, from https://nodejs.org (the LTS version).
- An **AI assistant that can run commands on your computer**, for example Claude Code (a paid Claude plan works).
- Only if a workflow needs them: the Telegram app, your own Google account (for a Google Sheet), an email app password. The setup asks what you use and tells you what you need.

## Install

TaskFollow is on npm as [`taskfollow`](https://www.npmjs.com/package/taskfollow). You don't install it by hand: your assistant does. Make a folder for TaskFollow and open your assistant in it. With Claude Code:

```bash
mkdir -p ~/Desktop/taskfollow
cd ~/Desktop/taskfollow
claude
```

Then paste this one sentence into your assistant:

> Please install TaskFollow for me. Run `npx --yes taskfollow instructions` and follow exactly what it prints. I am not technical: explain each step in plain words and tell me exactly what to click or type.

Your assistant downloads TaskFollow from npm (`npm install -g taskfollow`) and leads from there. Sometimes it asks you to paste a line into a **new** terminal window yourself: those are the decisions that are only yours (approvals, keys, turning a workflow on). Never paste a password or key into the chat; TaskFollow opens its own page on your computer for those.

## Which assistants

| | Works with you in the chat | Runs your work while you are away |
|---|---|---|
| **Claude Code** | Yes, tested | Yes, tested (certified on macOS) |
| **Codex, OpenClaw, Hermes, Pi, Gemini CLI, Cursor and other assistants that run commands** | Yes | Work that only reads and reports can run on your assistant's own scheduler. Work that sends, pays or deletes runs on TaskFollow's runner; its steps where a model judges something need a model key of your own (if your assistant already uses one, usually that one), entered once on TaskFollow's page. |

Antigravity can install and use TaskFollow with you in its chat; TaskFollow never starts it on its own, because its terms forbid invocation by other programs.

Claude Cowork on the web has no terminal, so it cannot install TaskFollow. Install it with an assistant that has one; TaskFollow can then hand a workflow that only reads and reports to Cowork, as a skill to upload and a scheduled task to paste.

Your assistant tells you what works on it: TaskFollow's checks say yes or no for each thing a workflow needs, and `taskfollow report` says what runs and what does not.

## Commands you run yourself

Your assistant runs most commands. These are the ones for you, in your own terminal:

| Command | What it does |
|---|---|
| `taskfollow approvals list` | What is waiting for your yes |
| `taskfollow approvals approve <id>` | Approve that exact action |
| `taskfollow approvals reject <id> --reason '<text>'` | Refuse it |
| `taskfollow why` | What ran in the last day, what it found, and why |
| `taskfollow report` | Where the setup stands and what runs |
| `taskfollow dryrun confirm <id>` | Turn on a workflow after you saw its dry run |
| `taskfollow resume` | Carry on after a break or a problem |
| `taskfollow pause` / `taskfollow unpause` | Stop everything at once / start again |
| `taskfollow doctor` | Check that everything is healthy |
| `taskfollow support bundle` | A file without secrets or personal data, to send for help |
| `taskfollow uninstall` | Remove TaskFollow and the keys it stored; your records and a copy of the audit are kept |
| `taskfollow uninstall --remove-skillswiki` | The same, and put your skills back from local Skills Wiki and remove it |

## Your data and keys

- Keys and passwords are entered on a page TaskFollow opens on your computer, never in the chat. They are kept in your computer's password safe.
- Your records stay where you keep them: on your computer, or in your own Google Sheet.
- Every action is written to an audit on your computer that `taskfollow why` reads.

## Status

Version 0.2.0 (first published on npm on 2026-10-19, as 0.1.0). The v1 build is complete and in its real-user test. Claude Code on macOS is certified; Windows is a Preview; Linux is untested. What is next: [`docs/next-steps.md`](docs/next-steps.md). The scope: [`docs/scope-refresh.md`](docs/scope-refresh.md), section 9.

## For developers

### What is certified

Support tiers follow spec §7.5. A runtime is **Certified** on a platform
only when a person ran `taskfollow certify` there from a clean checkout and
every check passed: the offline suite, every live check with its keys, and
the real agent's probe (D116). Nothing is certified by a CI service (O7,
D48). The record a run writes says which tier it reached and why.

| Runtime | Profile | macOS | Linux | Windows | Notes |
|---|---|---|---|---|---|
| Claude Code | `claude-code` | **Certified** 2026-10-12 (commit `437692c`, Claude Code 2.1.296, Node 22.14.0, macOS on Intel) | Not certified yet | Unknown | First real certification run (task 14): 1,360 offline and 18 live tests passed. Linux and Windows need a run of their own (task 16, D115). |
| Codex CLI | `codex` | Unknown | Unknown | Unknown | Its terms were reviewed and allow it (O2, D121). Its flags come from Codex's documentation and were not run (O1, task 15), so it stays Unknown until a certification passes. |
| Antigravity | none | — | — | — | In chat only; TaskFollow never starts it (D32, D114, D170, D175). |
| Any other agent | none | Unknown | Unknown | Unknown | Installs and uses TaskFollow in its chat, through `taskfollow tool`; workflow skills go in `.agents/skills` and are listed in `AGENTS.md`; scheduled judging needs a model key (§7.4, D175). |

When a certification passes, put its date, commit and agent version in
this table (see [`docs/release-checklist.md`](docs/release-checklist.md)).

### Development

- `npm test`: the offline suite (fakes only: no network, no real agent).
- `npm run test:live`: the opt-in live checks, with your own keys in the
  environment (D48).
- `npm run certify -- --profile claude-code --home ~/installer-certification`:
  certify a runtime on this machine (D116;
  [guide](docs/testing/2026-10-09-plan-10-live-test.md)).
- Design spec: [`docs/superpowers/specs/2026-10-06-installer-design.md`](docs/superpowers/specs/2026-10-06-installer-design.md)
- Decision log: [`DECISIONS.md`](DECISIONS.md)
- Release checklist: [`docs/release-checklist.md`](docs/release-checklist.md)

## License

TaskFollow is source-available under the Elastic License 2.0 with one
added limitation: you may not be paid to install, run or support it for
someone else, or sell it inside a product. Using it for your own work,
also inside a business, is allowed. See [`LICENSE`](LICENSE) (D177).
