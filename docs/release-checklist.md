# Release checklist

The installer is not published: `package.json` says `"private": true`, so
`npm publish` refuses. This list prepares a release that a person installs
from a tarball. Publishing to a registry is a separate decision (D119).

## 1. Before

- [ ] Every plan branch is merged into `main` in order, and `git status` is clean on `main`.
- [ ] `npm ci`, `npm run typecheck` and `npm test` pass (offline, about two minutes).
- [ ] The human tasks this release depends on are done or deferred on purpose (`docs/human-tasks.md`).

## 2. Certify

- [ ] For each runtime and platform the release claims, run
      `npm run certify -- --profile <id> --home ~/installer-certification`
      from the clean checkout, with the live keys in the environment and
      `INSTALLER_LIVE_AGENT=1` (guide: `docs/testing/2026-10-09-plan-10-live-test.md`).
- [ ] Only a record whose `tier` is `certified` and whose `commit` is the
      release commit counts. Copy its date, `commit` and `agent_version`
      into the README's "What is certified" table; anything else stays
      Compatible or Unknown there, with the record's `reasons`.

## 3. Version

Semantic versioning, judged by what an existing install sees:

- **patch** (`0.1.0` → `0.1.1`): fixes only; no new command, flag, field or profile.
- **minor** (`0.1.1` → `0.2.0`): something new that every existing install keeps working with: a command, a profile, a connector, a channel, a tool.
- **major** (`0.x` → `1.0.0`, then `2.0.0`): something an existing install cannot take as it is: `install-state.json`'s `schema`, the profile format, a removed command or flag, a changed exit code.
- While the version starts with `0.`, a minor bump may carry a breaking change; the release notes then say so.

- [ ] `npm version <patch|minor|major> --no-git-tag-version`, commit
      `chore(release): <version>`, and tag `v<version>` on `main` after the merge.

## 4. Package

- [ ] `npm run build`, then `npm pack --dry-run`: `dist/`, `profiles/`,
      `connectors/`, `solutions/`, `INSTALL.md`, `README.md` and
      `package.json`, and nothing from `tests/`, `src/` or `docs/` (the
      offline suite checks the same in `tests/e2e/release.test.ts`).
- [ ] `npm pack` writes `taskfollow-<version>.tgz`. On a clean machine or a
      new user account with Node 22: `npm install -g ./taskfollow-<version>.tgz`,
      then `taskfollow version` and `taskfollow probe`.
- [ ] Keep the tarball next to the certification records; never commit it.

## 5. Not part of a release

- Publishing to npm: it needs `"private": true` removed, a package name that
  is free, and an npm account (a decision for Allen).
- Signed installer updates (D65, D111).
- CI: none, by decision (O7, D48); the offline suite runs on the developer's machine.
