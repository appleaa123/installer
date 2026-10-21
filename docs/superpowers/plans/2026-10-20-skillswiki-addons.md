# Plan (revised after Fable review): TaskFollow with optional local and hosted Skills Wiki

## Context

TaskFollow (`installer`, taskfollow@0.1.1) is the one product people install. Setup offers two optional add-ons:
1. **Local Skills Wiki** (open source v0.3.2, runs on the person's machine, its own stdio MCP `skillswiki serve-mcp`): manages the skills already installed across all their agents.
2. **Hosted Skills Wiki** (remote, per-account MCP URL, paid, account + API key): more skills and combos.

No to both → TaskFollow behaves exactly as 0.1.1. Two repos, one product: TaskFollow installs a pinned Skills Wiki with pipx. Skills Wiki keeps its own wiring (MCP + hook + rules, in every agent). Hosted product design is out of scope; the private `skills_wiki` repo is not touched.

### Your decisions
1. Local: warn that skills move into the Skills Wiki library, then TaskFollow runs Skills Wiki setup.
2. Two repos, one product (TaskFollow installs a pinned Skills Wiki with pipx).
3. Skills Wiki keeps its own connection to every agent (no skills tools in TaskFollow's MCP).
4. Hosted: the person pastes their dashboard MCP URL. A fixed URL is impossible because each account has its own.

### What changed from the other agent's plan
- Removed: the `skills.*` MCP tool group, `toolsFor()`, the `--no-mcp` change to Skills Wiki, and the new `skill:<slug>` reference with hash pinning.
- Added: the move warning and `--confirm-move`, running setup from the home folder, the library as an extra skill folder, the hosted `brain.url` steps, a separate MCP name for hosted (`skillswiki-hosted`), and the fixes from Fable's review (B1–B3, H1–H4, S1–S11).

### Facts that shaped this plan (verified in code)
- `skillswiki setup` **moves** every skill into `<SKILLSWIKI_HOME|~/.skillswiki>/library/<slug>/` (slug = folder name); `suggest`/`load` only work on moved skills. `--json` = automatic, no prompts, no TTY. A backup zip is written before moving. Run with `cwd` = home: project folders then de-duplicate into the user folders, and TaskFollow's `<install>/.claude/skills/<workflow>/` is never touched.
- `setup --json` always exits 0 and drops MCP/hook failure reasons; result shape `{mode, stopped, plan, moved:{adopted[],failed[]}, agents[], backup}`. `skillswiki --json doctor` gives `version`, `wiring[].mcp`, `library.path`. There is no `--version`.
- Hosted MCP URL is per account: `https://skills-portal.skills-library.workers.dev/<client_id>/mcp`.
- Hosted and local both use the MCP name `skillswiki` (`skillswiki.ts:9`, `wiring_data.py:8`); `registerMcpConfig` is remove-then-add (`register.ts:62-69`).
- ~15 readers decide "hosted is on" by `state.skillswiki !== undefined`; `state.skillswiki` is set only at `start --url` or by an auto action's `StatePatch` (`types.ts:160`).
- `usesSkillswiki(solution)` ignores `when`, so `start` (`cli.ts:221`) would demand `--url` from everyone once `brain.*` is in `starter.json`.
- `addService` reads the pinned solution: installs made before this version cannot `add skills|skillswiki`.
- A failing non-blocking auto step becomes `blocked`; `resume` retries it; the report says `ready_with_limits`.

## Design

### Questions (`starter.json`, both default `none`, gated `mode.purpose = install`)
- `services.skills` (`skills`/`none`): "Should TaskFollow set up Skills Wiki to manage the AI skills you already have, across all your agents? Your installed skills will move into the Skills Wiki library (~/.skillswiki); your agents then reach them through Skills Wiki. `skillswiki release --all` puts them back."
- `services.skillswiki` (`skillswiki`/`none`): "Do you want to connect hosted Skills Wiki for more skills and ready-made combos? It is a paid service and needs a Skills Wiki account."
- `starter-skillswiki.json` gets only `services.skills` (hosted is always on there).
- `taskfollow add skills` refuses unless given `--confirm-move`; its refusal message is the move warning, so the agent must show it and get a yes. `add skillswiki` works as D134.

### Local (`services.skills = skills`)
Step `skills.install`: auto `install_skillswiki`, `blocking: false`, BRAIN-phase-safe position after the services questions.
1. Using the env it is given (never `process.env` directly): find `pipx` and a Python ≥ 3.11 (`python3.13`…`python3.11`, `python3`). Missing → fail with a hint: "install Python 3.11+ and pipx, then run `taskfollow resume`" (step becomes `blocked`, setup goes on, report `ready_with_limits`).
2. `skillswiki --json doctor` shows the pinned version → skip to 4 (idempotent).
3. `pipx install --python <found> git+https://github.com/appleaa123/skills_wiki_opensource.git@v0.3.2` (tag constant; long timeout).
4. `skillswiki --json setup` with `cwd` = home. Fail if `stopped` or `moved.failed` is not empty.
5. `skillswiki --json doctor`: confirm wiring; write `config/skillswiki-local.json` `{version, tag, library}` (library path from doctor, so the tick's different env cannot drift). Audit `skillswiki.installed` with tag, moved count, backup path.
- Process calls use a new stderr-capturing variant of `runProcess` (`headless.ts:55` discards stderr today); `execFile`, no shell.

### Runner and inventory
- `SkillRoots` gains `library?`, read from `config/skillswiki-local.json`; added to `realRoots`/`skillFolder` (`skills.ts:194,207`) and `inventory` (source `"Skills Wiki (local)"`). Writers only use `roots.project`, so nothing is ever written to the library.
- Any missing local ref falls back to `library/<basename>/SKILL.md` when it exists, noted in `why`. This also covers a person who later runs `skillswiki setup` from the install folder.
- Test env var for the library (like `INSTALLER_AGENT_USER_SKILLS`) set in `vitest.config.ts`.

### Hosted (`services.skillswiki = skillswiki`)
- Copy `brain.key`, `brain.register`, `brain.combo`, `brain.probe-mcp` into `starter.json` gated `all: [mode.purpose=install, services.skillswiki=skillswiki]`, with two new steps before `brain.key`:
  - `brain.url`: ask, new input kind `url`, validated at submit with `requireSkillswikiUrl` (`skillswiki.ts:75`, still allows `http://127.0.0.1` for tests). "Paste the MCP URL from your Skills Wiki dashboard (if you started with --url, give the same one)."
  - `brain.url-set`: auto `set_skillswiki_url`, reads the answer like `derive_mode` (`mode.ts:35`), returns `{ skillswiki: { url: state.skillswiki?.url ?? answer } }`. Widen `StatePatch` with `skillswiki`. All existing readers then work unchanged.
- `cli.ts:221`: validate `--url` only when given; `skillswiki:` solution refs still require it.
- Hosted MCP name becomes `skillswiki-hosted` for new registrations (`probe_mcp` server name follows). Uninstall removes `skillswiki-hosted`, and the legacy `skillswiki` only when local is not on.
- `requireSameUrl` message also covers an answered URL. INSTALL.md §11 "cannot be switched" goes away.

### Isolation from TaskFollow's own agent calls
Task runs are `--restricted` (hook not fired), but judge, agentic and probe calls are not. The spike measures whether Skills Wiki's hook adds text or delay there. If it does: a small OSS change, `skillswiki hook` prints nothing when `SKILLSWIKI_HOOK_OFF=1` (pytest test), and TaskFollow sets that env on its own agent calls.

### Lifecycle
- `doctor-checks.ts`: local on → `skillswiki` found, version = pinned.
- `taskfollow uninstall --remove-skillswiki` (default: keep, say `~/.skillswiki` stays): `skillswiki --json uninstall --yes`; if it reports `blocked`, stop and do not `pipx uninstall`; else `pipx uninstall skillswiki`.
- `report.ts`: one line per add-on.

## Steps
1. **Spike** (scratch HOME, `SKILLSWIKI_HOME`, `PIPX_HOME`/`PIPX_BIN_DIR`; install pipx in scratch): record `setup`/`doctor`/`uninstall` JSON fixtures; pipx `--python`, idempotency, timing; `claude mcp add --scope user` under a fake HOME; hook effect on a judge-style `claude -p`.
2. Hosted fixes (B1, B2, `brain.url`, `brain.url-set`, `url` input kind, `StatePatch`) with tests.
3. Local install action + process helper + questions + `--confirm-move`.
4. Library skill root + fallback.
5. Lifecycle (doctor, uninstall flag, report); hook-off change if the spike requires it.
6. Docs: INSTALL.md (both questions, move and cost warnings, `resume`, `add … --confirm-move`, add-ons only for installs made with this version, "run skillswiki setup from your home folder"), README, DECISIONS.md entry (amends D154 and D134; MCP name change), version bump.

## Tests (TDD: failing first; fakes on a temp PATH like `tests/fakes/fake-agent.mjs`)
- install: no Python / old Python / no pipx → `blocked` + `ready_with_limits` + hint; success → config file, audit, setup ran with cwd = home; re-run → no reinstall; `stopped` or `moved.failed` → fails with reason; stderr reaches the message.
- services: both `none` → same visible steps as 0.1.1, `start` needs no `--url`; warnings in both question texts; `add skills` without `--confirm-move` refused with the warning; `add skillswiki` → `brain.url` is next.
- hosted: bad URL refused at submit; `brain.url-set` sets `state.skillswiki`; `start --url` wins; MCP registered as `skillswiki-hosted`.
- skills: off → roots identical; on → library listed, read into prompt, missing ref falls back, outside path refused.
- uninstall: keep → nothing run; remove → order; blocked → no pipx uninstall; local MCP kept when hosted removed.
- live (`INSTALLER_LIVE=1`): real pipx install in scratch with one test skill.

## Verification
1. `npm run typecheck && npm test` green (and `pytest` in OSS repo if the hook change happens).
2. No to both, scratch home: setup finishes; `claude mcp list` and `~/.claude/settings.json` byte-identical; tool list identical to 0.1.1.
3. Yes to local with a fake HOME: skill moved to library, backup zip exists, Skills Wiki wired, `taskfollow skills` lists it, sandbox workflow run reads it, `why` shows it, install-folder workflow skills untouched.
4. Python hidden from PATH: step blocked with hint, setup completes `ready_with_limits`.
5. Default install, `add skillswiki`: URL asked, key, register as `skillswiki-hosted` (against the test MCP server).
6. Uninstall `--remove-skillswiki`: skills back, Skills Wiki unwired and uninstalled.
7. Update memory `project-installer-design.md`.

## As built (2026-10-20)
- No separate report line per add-on: a blocked `skills.install` already shows under "Limited" in the report.
- No `why` note for the library fallback.
- No `INSTALLER_LIVE` test; the real pipx install, setup and removal were run by hand in a scratch HOME.
- The hook change was needed; it shipped as skills_wiki_opensource 0.3.3, which is the pinned version.
