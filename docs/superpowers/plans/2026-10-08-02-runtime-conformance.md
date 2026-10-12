# Runtime Conformance Implementation Plan (Plan 2 of 10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a real host agent run an install end to end without any secret: runtime profiles as data, `installer probe` (C2, C4, C4 schema, C5) with a capability map in the state and the report, `https:` solution refs with a pinned `recipe_version`, the MODE phase (Q1–Q3 → mode and decision maker), per-runtime hints on `agent_action` steps, and an agent-readable `INSTALL.md`.

**Architecture:** Profiles are JSON files (`profiles/<id>.json`) that describe how to detect an agent and call it headless. A small runner (`src/core/headless.ts`) fills a profile's argv template and spawns the agent with no shell. `src/core/probe.ts` runs the conformance checks and returns a `CapabilityMap`. Two new auto actions, `probe_runtime` and `derive_mode`, return a *state patch* that the engine merges into the install state in the same atomic save as the step record. Everything is tested in CI against a fake agent script; the real Claude Code profile values were verified live before this plan was written.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Node ≥ 22 built-ins only at runtime (`node:child_process` `spawn`, `node:crypto`, global `fetch`), Vitest. Still no runtime dependencies.

**Spec:** [`docs/superpowers/specs/2026-10-06-installer-design.md`](../specs/2026-10-06-installer-design.md) §5 (modes), §6.1–6.3, §7.1–7.5. Decisions in [`DECISIONS.md`](../../../DECISIONS.md) (D7, D9, D21, D32, D44, and D46 added by this plan). Roadmap: [`README.md`](README.md). Builds on [Plan 1](2026-10-06-01-engine-core.md).

**Scope decision (approved 2026-10-08, recorded as D46):** this plan needs no secret. Everything that needs the Skills Wiki API key — key entry, MCP registration, the C6 probe, `skillswiki:` refs, the combo check — moves to Plan 3, which becomes "Secrets + BRAIN phase". The connector framework moves from Plan 3 to Plan 5. When Plan 3 registers the Skills Wiki MCP, **the engine runs the registration command itself** with the key read from the keychain, so the key never enters the agent's context (R4 and D8 take precedence over D7's "agent implements natively").

## Facts verified live before writing (2026-10-08, Claude Code 2.1.294, macOS)

| Fact | Command | Observed |
|---|---|---|
| Headless JSON output | `claude -p "<prompt>" --output-format json` | Text at `.result`, session at `.session_id`, error flag `.is_error` |
| Structured output | `… --json-schema '<schema>'` | Object at `.structured_output` (also echoed as text in `.result`) |
| Session resume | `… -r <session_id>` | Recalled a word from the first call; same `session_id` returned |
| Tools and MCP off | `--tools "" --strict-mcp-config` | Accepted; the call ran with no tools and no MCP servers |
| O6 (for Plan 3) | `claude mcp add --help` | `claude mcp add [-s local\|user\|project] --transport http <name> <url> --header "Authorization: Bearer <key>"` |

The spec's §7.2 example uses `--restricted` as the tools-off flag. `--restricted` exists but only removes code-running tools; `--tools ""` removes all of them, so the profile uses `--tools ""`. Task 9 updates the spec.

## Global Constraints

- Everything in Plan 1's Global Constraints still applies (Node ≥ 22, strict TS, ESM `.js` suffixes, zero runtime dependencies, immutable updates, functions < 50 lines, files < 400 lines, no `console.log`, exit codes `0/1/2/3`, spec field names verbatim, D34 confinement, R4, R9/D27).
- Headless agent calls never use a shell: `spawn(file, args)` with an argv array, `stdin` ignored. A prompt is one argv element, never interpolated into a command string.
- Every headless call has a timeout (default 120 000 ms) and an output cap (1 000 000 characters). A failing, hanging or garbled agent is a *probe result*, never a crash of the engine.
- Headless calls run with tools and MCP servers off (profile flags) and with the working directory `<engine_home>/runtime/probe` (created `0700`, confined with `confinedPath`).
- No secret is ever placed in a prompt, a profile, an argv element or the state in this plan.
- Profiles are data (JSON). Adding an agent means adding a profile file, never code (D32).
- New install state fields are optional, so `schema` stays `1` and Plan 1 state files keep loading.
- `skillswiki:` refs are refused with a message that names the reason; plain `http:` refs are refused (HTTPS only).

## Review Focus

1. **The agent hangs, prints non-JSON or prints too much.** The probe records that capability as failed with a short note, the install continues, and the report shows the limit. Test: Task 4.
2. **No known agent is installed (or its command is not on `PATH`).** The probe returns an *unknown* runtime instead of throwing; the report says fallbacks apply. Test: Task 4 and Task 5.
3. **An `https:` solution URL fails** (HTTP 404, redirect to `http:`, body over 1 MB, network error). `start` exits `2` with the URL in the message and creates no home. Test: Task 1.
4. **`derive_mode` names a step that does not exist or is not before it.** The solution is refused at load time, naming the step, before any home is created. Test: Task 6.
5. **A prompt that contains shell syntax** (`$(…)`, quotes, `;`). It reaches the agent as literal text and nothing is executed. Test: Task 3.

---

## File Structure

```
profiles/
  claude-code.json             # NEW bundled runtime profile (verified values)
solutions/
  starter.json                 # NEW starter solution: probe + MODE + final marker
INSTALL.md                     # NEW agent-readable bootstrap template (operator rules)
package.json                   # MODIFY files: + profiles, solutions, INSTALL.md
src/
  cli.ts                       # MODIFY https refs, recipe_version, `probe` command, --profile, ProfileError → 2
  core/
    types.ts                   # MODIFY Mode, Roles, CapabilityMap, StatePatch, hints, new state fields
    state.ts                   # MODIFY isInstallState accepts the new optional fields
    solution.ts                # MODIFY https: refs, fetchHttps, hints parsing, derive_mode reference check
    engine.ts                  # MODIFY start(recipeVersion), merge action state patches, hints + retry in views
    actions.ts                 # MODIFY actions return a StatePatch; + probe_runtime, derive_mode
    profile.ts                 # NEW profile schema, loader, bundled list, version compare
    headless.ts                # NEW argv templates, runProcess, runHeadless
    probe.ts                   # NEW detectAgent, runProbe → CapabilityMap
    mode.ts                    # NEW deriveMode, deriveModeAction
    report.ts                  # MODIFY runtime line, runtime limits feed READY WITH LIMITS
tests/
  fakes/fake-agent.mjs         # NEW headless agent test double (switch: FAKE_AGENT_DROP)
  fixtures/
    profiles/fake-agent.json   # NEW profile pointing at the fake agent
    profiles/missing-agent.json# NEW profile whose command does not exist
    solution-starter.json      # NEW starter solution wired to the fake agent
  operator/scripted-operator.ts# MODIFY + STARTER_REF, STARTER_SCRIPT
  unit/
    solution-refs.test.ts      # NEW
    state-fields.test.ts       # NEW
    profile.test.ts            # NEW
    headless.test.ts           # NEW
    probe.test.ts              # NEW
    mode.test.ts               # NEW
    hints.test.ts              # NEW
    report.test.ts             # MODIFY runtime line
    neutrality.test.ts         # MODIFY scan profiles/, solutions/, INSTALL.md
  e2e/
    cli.test.ts                # MODIFY https/http refs, recipe_version, probe command
    install-doc.test.ts        # NEW INSTALL.md rules + starter install end to end
docs/
  superpowers/specs/2026-10-06-installer-design.md   # MODIFY (Task 9)
  superpowers/plans/README.md                        # MODIFY roadmap (Task 9)
  testing/2026-10-08-plan-2-live-test.md             # NEW live test guide (Task 9)
DECISIONS.md                   # MODIFY + D46 (Task 9)
```

---

### Task 1: State fields, `https:` refs and `recipe_version`

**Files:**
- Modify: `src/core/types.ts`, `src/core/state.ts`, `src/core/solution.ts`, `src/core/engine.ts` (`initialState`, `start`), `src/cli.ts` (`startCommand`)
- Test: `tests/unit/solution-refs.test.ts` (new), `tests/unit/state-fields.test.ts` (new), `tests/e2e/cli.test.ts`

**Interfaces:**
- Consumes: Plan 1 `parseSolutionText(text, where)`, `SolutionError`, `isInstallState`, `start(deps, existing, ref)`.
- Produces (used by every later task):
  - `types.ts`: `MODES`, `Mode`, `Roles { decision_maker: string }`, `CapabilityMap`, `StatePatch`, `StepDef.hints?`, `InstallState.mode?`, `.roles?`, `.runtime?`, `.solution.recipe_version?`.
  - `solution.ts`: `MAX_SOLUTION_BYTES`, `type FetchText = (url: string) => Promise<string>`, `fetchHttps(url): Promise<string>`, `loadSolutionSource(ref, fetchText = fetchHttps)`.
  - `engine.ts`: `initialState(ref, solution, now, recipeVersion?)`, `start(deps, existing, ref, recipeVersion?)`.

- [ ] **Step 1: Add the new types**

In `src/core/types.ts`, add after `StepDef`'s `verify` field:

```ts
  readonly hints?: Readonly<Record<string, readonly string[]>>;
```

Add before `export interface InstallState`:

```ts
export const MODES = ["personal", "team_host", "hybrid"] as const;
export type Mode = (typeof MODES)[number];

export interface Roles {
  readonly decision_maker: string;
}

/** Result of `installer probe` (spec §7.3). C6 is probed by Plan 3. */
export interface CapabilityMap {
  readonly profile: string | null;
  readonly agent_version: string | null;
  readonly c2_shell: boolean;
  readonly c4_headless: boolean;
  readonly c4_schema: boolean;
  readonly c5_resume: boolean;
  readonly c6_mcp: "not_probed";
  readonly support_level: number;
  readonly tier: "compatible" | "unknown";
  readonly notes: readonly string[];
}
```

Replace `InstallState` with:

```ts
export interface InstallState {
  readonly schema: 1;
  readonly solution: { readonly ref: string; readonly id: string; readonly version: string; readonly recipe_version?: string };
  readonly started_at: string;
  readonly steps: Readonly<Record<string, StepRecord>>;
  readonly audit_head?: AuditHead;
  readonly mode?: Mode;
  readonly roles?: Roles;
  readonly runtime?: CapabilityMap;
}

/** What an auto action may change in the install state, merged in the same save as its step record. */
export type StatePatch = Partial<Pick<InstallState, "mode" | "roles" | "runtime">>;
```

- [ ] **Step 2: Write the failing state test**

Create `tests/unit/state-fields.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isInstallState } from "../../src/core/state.js";

const base = { schema: 1, solution: { ref: "file:/s.json", id: "s", version: "1" }, started_at: "2026-01-01T00:00:00.000Z", steps: {} };
const runtime = {
  profile: "claude-code", agent_version: "2.1.294", c2_shell: true, c4_headless: true, c4_schema: true, c5_resume: true,
  c6_mcp: "not_probed", support_level: 2, tier: "compatible", notes: [],
};

describe("install state fields added by Plan 2", () => {
  it("accepts recipe_version, mode, roles and runtime", () => {
    const state = { ...base, solution: { ...base.solution, recipe_version: "abc" }, mode: "team_host", roles: { decision_maker: "Owner" }, runtime };
    expect(isInstallState(state)).toBe(true);
  });

  it("still accepts a Plan 1 state without them", () => {
    expect(isInstallState(base)).toBe(true);
  });

  it.each([
    ["an unknown mode", { ...base, mode: "boss" }],
    ["roles without a decision maker", { ...base, roles: {} }],
    ["a non-string recipe_version", { ...base, solution: { ...base.solution, recipe_version: 5 } }],
    ["a runtime without a support level", { ...base, runtime: { profile: null } }],
  ])("rejects %s", (_name, state) => {
    expect(isInstallState(state)).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run tests/unit/state-fields.test.ts`
Expected: FAIL — the four "rejects" cases return `true` (the fields are not checked yet).

- [ ] **Step 4: Validate the new fields**

In `src/core/state.ts`, change the types import to `import { MODES, STEP_STATUSES, type InstallState } from "./types.js";` and replace `isInstallState` with:

```ts
function hasValidExtras(value: Record<string, unknown>): boolean {
  const { mode, roles, runtime } = value;
  if (mode !== undefined && !(MODES as readonly unknown[]).includes(mode)) return false;
  if (roles !== undefined && !(isRecord(roles) && typeof roles.decision_maker === "string")) return false;
  return runtime === undefined || (isRecord(runtime) && typeof runtime.support_level === "number");
}

export function isInstallState(value: unknown): value is InstallState {
  if (!isRecord(value) || value.schema !== 1 || typeof value.started_at !== "string") return false;
  const { solution, steps, audit_head: head } = value;
  if (!isRecord(solution) || !["ref", "id", "version"].every((key) => typeof solution[key] === "string")) return false;
  if (solution.recipe_version !== undefined && typeof solution.recipe_version !== "string") return false;
  if (!isRecord(steps) || !Object.values(steps).every(isStepRecord)) return false;
  if (!hasValidExtras(value)) return false;
  return head === undefined || (isRecord(head) && typeof head.seq === "number" && typeof head.hash === "string");
}
```

Run: `npx vitest run tests/unit/state-fields.test.ts` — Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing ref tests**

Create `tests/unit/solution-refs.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_SOLUTION_BYTES, fetchHttps, loadSolutionSource } from "../../src/core/solution.js";
import { FIXTURE_PATH } from "../helpers/memory-deps.js";

const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, "utf8");
const URL_OK = "https://example.test/s.json";
/** A constructed Response has an empty url; set the final URL the way fetch would after redirects. */
const at = (url: string, response: Response): Response => Object.defineProperty(response, "url", { value: url });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("https: solution refs", () => {
  it("loads a solution through the fetcher and keeps its exact text", async () => {
    const loaded = await loadSolutionSource(URL_OK, async () => FIXTURE_TEXT);
    expect(loaded.solution.id).toBe("fixture-basic");
    expect(loaded.text).toBe(FIXTURE_TEXT);
  });

  it("fetchHttps returns the body of a 200 answer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(at(URL_OK, new Response(FIXTURE_TEXT)));
    await expect(fetchHttps(URL_OK)).resolves.toBe(FIXTURE_TEXT);
  });

  it.each([
    ["a non-200 answer", () => at(URL_OK, new Response("gone", { status: 404 })), /answered HTTP 404/],
    ["a redirect to http", () => at("http://example.test/s.json", new Response(FIXTURE_TEXT)), /redirected away from https/],
    ["a body over the size cap", () => at(URL_OK, new Response("x".repeat(MAX_SOLUTION_BYTES + 1))), /larger than 1000000 bytes/],
  ])("refuses %s (Review Focus 3)", async (_name, response, message) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response());
    await expect(fetchHttps(URL_OK)).rejects.toThrow(message);
  });

  it("names the URL when the network fails (Review Focus 3)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(fetchHttps(URL_OK)).rejects.toThrow("Cannot fetch solution URL 'https://example.test/s.json' (fetch failed)");
  });

  it.each(["http://example.test/s.json", "ftp://example.test/s.json"])("refuses the unsupported ref %s", async (ref) => {
    await expect(loadSolutionSource(ref)).rejects.toThrow(/use file:<path> or https:/);
  });

  it("explains that skillswiki: refs need the Skills Wiki key step", async () => {
    await expect(loadSolutionSource("skillswiki:pack/skill/recipe.json")).rejects.toThrow(/Skills Wiki key step/);
  });
});
```

Run: `npx vitest run tests/unit/solution-refs.test.ts`
Expected: FAIL — `fetchHttps` and `MAX_SOLUTION_BYTES` are not exported.

- [ ] **Step 6: Implement `https:` refs**

In `src/core/solution.ts`, replace `loadSolutionSource` with:

```ts
export const MAX_SOLUTION_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 30_000;

export type FetchText = (url: string) => Promise<string>;

/** HTTPS only, follows redirects but never to another scheme, size-capped (Review Focus 3). */
export async function fetchHttps(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new SolutionError(`Cannot fetch solution URL '${url}' (${(error as Error).message})`);
  }
  if (!response.url.startsWith("https:")) throw new SolutionError(`Solution URL '${url}' redirected away from https`);
  if (!response.ok) throw new SolutionError(`Solution URL '${url}' answered HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_SOLUTION_BYTES) {
    throw new SolutionError(`Solution at '${url}' is larger than ${MAX_SOLUTION_BYTES} bytes`);
  }
  return text;
}

async function readLocal(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new SolutionError(`Cannot read solution file '${path}'`);
  }
}

export async function loadSolutionSource(ref: string, fetchText: FetchText = fetchHttps): Promise<{ solution: Solution; text: string }> {
  if (ref.startsWith("skillswiki:")) {
    throw new SolutionError("'skillswiki:' references need the Skills Wiki key step, which arrives in a later version; use a file: or https: reference");
  }
  if (ref.startsWith("https:")) {
    const text = await fetchText(ref);
    return { solution: parseSolutionText(text, ref), text };
  }
  if (!ref.startsWith("file:")) throw new SolutionError(`Unsupported solution reference '${ref}': use file:<path> or https://…`);
  const path = ref.slice("file:".length);
  const text = await readLocal(path);
  return { solution: parseSolutionText(text, path), text };
}
```

Run: `npx vitest run tests/unit/solution-refs.test.ts` — Expected: PASS (9 tests).

- [ ] **Step 7: Write the failing `recipe_version` tests**

Add this block at the end of `tests/unit/engine-advance.test.ts` (it uses the file's existing imports `start`, `memoryDeps`, `basicSolution`, `FIXTURE_REF`, `makeTempHome`):

```ts
describe("recipe_version", () => {
  it("is stored in the state on a fresh start", async () => {
    const { deps } = memoryDeps(await makeTempHome(), basicSolution());
    const { state } = await start(deps, null, FIXTURE_REF, "sha-of-text");
    expect(state.solution.recipe_version).toBe("sha-of-text");
  });
});
```

Add to `tests/e2e/cli.test.ts` (add `import { createHash } from "node:crypto";` and `import { loadState } from "../../src/core/state.js";` at the top):

```ts
  it("records the solution's content sha as recipe_version", async () => {
    const home = await makeTempHome();
    runCli(["start", "--solution", FIXTURE_REF], { home });
    const sha = createHash("sha256").update(await readFile(FIXTURE_PATH, "utf8")).digest("hex");
    expect((await loadState(home))?.solution.recipe_version).toBe(sha);
  });

  it.each(["http://example.test/s.json", "skillswiki:pack/skill/recipe.json"])("refuses %s with exit 2 and creates nothing", async (ref) => {
    const home = join(await makeTempHome(), "engine");
    const result = runCli(["start", "--solution", ref], { home });
    expect(result.code).toBe(2);
    await expect(access(home)).rejects.toThrow();
  });
```

Run: `npx vitest run tests/unit/engine-advance.test.ts tests/e2e/cli.test.ts`
Expected: FAIL — `recipe_version` is `undefined`.

- [ ] **Step 8: Store `recipe_version`**

In `src/core/engine.ts`, replace `initialState` and the head of `start`:

```ts
export function initialState(ref: string, solution: Solution, now: string, recipeVersion?: string): InstallState {
  const pinned = { ref, id: solution.id, version: solution.version, ...(recipeVersion ? { recipe_version: recipeVersion } : {}) };
  return { schema: 1, solution: pinned, started_at: now, steps: {} };
}
```

```ts
export async function start(deps: EngineDeps, existing: InstallState | null, ref: string, recipeVersion?: string): Promise<Advanced> {
```

and inside `start`, change the fresh-state line to:

```ts
  const fresh: InstallState = { ...initialState(ref, deps.solution, deps.now(), recipeVersion), audit_head: head };
```

In `src/cli.ts` `startCommand`, change the last line to:

```ts
  return (await start(depsFor(home, solution), existing, ref, sha256(text))).result;
```

- [ ] **Step 9: Update the Plan 1 test that expected `https:` to be refused**

`tests/unit/solution.test.ts` has `it("rejects unsupported references")`, which calls `loadSolution("https://example.com/solution.json")` and expects `/only file:/`. After Step 6 that ref is fetched for real (a live network call), so change the test to:

```ts
  it("rejects unsupported references", async () => {
    await expect(loadSolution("ftp://example.com/solution.json")).rejects.toThrow(/use file:<path> or https:/);
  });
```

- [ ] **Step 10: Run the whole suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck exits 0; all tests pass (Plan 1's 155 plus this task's new ones), with no network access needed.

- [ ] **Step 11: Commit**

```bash
git add src/core/types.ts src/core/state.ts src/core/solution.ts src/core/engine.ts src/cli.ts tests/unit/state-fields.test.ts tests/unit/solution-refs.test.ts tests/unit/engine-advance.test.ts tests/unit/solution.test.ts tests/e2e/cli.test.ts
git commit -m "feat(core): accept https solution refs and pin recipe_version"
```

---

### Task 2: Runtime profiles

**Files:**
- Create: `src/core/profile.ts`, `profiles/claude-code.json`, `tests/fixtures/profiles/fake-agent.json`, `tests/fixtures/profiles/missing-agent.json`
- Modify: `package.json` (`files`), `src/cli.ts` (`exitCodeFor`)
- Test: `tests/unit/profile.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `class ProfileError extends Error`
  - `interface RuntimeProfile { id; name; min_version; detect: { cmd: readonly string[]; match: string }; headless: { cmd: readonly string[]; result_path: string; session_path: string; error_path?: string }; schema?: { flag: readonly string[]; result_path: string }; resume?: { flag: readonly string[] }; tos_review: { status: "ok" | "pending" | "blocked"; note: string }; dir: string }` — `dir` is the folder the profile was loaded from, not stored in the file.
  - `PROFILES_DIR: string`, `parseProfile(raw: unknown, dir: string): RuntimeProfile`, `loadProfile(ref: string): Promise<RuntimeProfile>`, `listBundledProfiles(): Promise<RuntimeProfile[]>`, `versionAtLeast(actual: string, min: string): boolean`.

- [ ] **Step 1: Write the profile files**

Create `profiles/claude-code.json` (values verified live, see "Facts verified live"):

```json
{
  "id": "claude-code",
  "name": "Claude Code",
  "min_version": "2.1.0",
  "detect": { "cmd": ["claude", "--version"], "match": "Claude Code" },
  "headless": {
    "cmd": ["claude", "-p", "{prompt}", "--output-format", "json", "--tools", "", "--strict-mcp-config"],
    "result_path": "result",
    "session_path": "session_id",
    "error_path": "is_error"
  },
  "schema": { "flag": ["--json-schema", "{schema_json}"], "result_path": "structured_output" },
  "resume": { "flag": ["-r", "{session_id}"] },
  "tos_review": { "status": "ok", "note": "First-party CLI used headless by the client on their own account." }
}
```

Create `tests/fixtures/profiles/fake-agent.json`:

```json
{
  "id": "fake-agent",
  "name": "Fake Agent",
  "min_version": "1.0.0",
  "detect": { "cmd": ["node", "{profile_dir}/../../fakes/fake-agent.mjs", "--version"], "match": "Fake Agent" },
  "headless": {
    "cmd": ["node", "{profile_dir}/../../fakes/fake-agent.mjs", "-p", "{prompt}", "--output-format", "json"],
    "result_path": "result",
    "session_path": "session_id",
    "error_path": "is_error"
  },
  "schema": { "flag": ["--json-schema", "{schema_json}"], "result_path": "structured_output" },
  "resume": { "flag": ["-r", "{session_id}"] },
  "tos_review": { "status": "ok", "note": "Test double used only by the test suite." }
}
```

Create `tests/fixtures/profiles/missing-agent.json`:

```json
{
  "id": "missing-agent",
  "name": "Missing Agent",
  "min_version": "1.0.0",
  "detect": { "cmd": ["installer-test-no-such-agent", "--version"], "match": "Missing Agent" },
  "headless": { "cmd": ["installer-test-no-such-agent", "-p", "{prompt}"], "result_path": "result", "session_path": "session_id" },
  "tos_review": { "status": "ok", "note": "Test profile whose command does not exist." }
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/unit/profile.test.ts`:

```ts
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileError, listBundledProfiles, loadProfile, parseProfile, versionAtLeast } from "../../src/core/profile.js";

const FAKE = resolve("tests/fixtures/profiles/fake-agent.json");
const valid = {
  id: "x", name: "X", min_version: "1.0.0",
  detect: { cmd: ["x", "--version"], match: "X" },
  headless: { cmd: ["x", "-p", "{prompt}"], result_path: "result", session_path: "session_id" },
  tos_review: { status: "ok", note: "n" },
};

describe("runtime profiles", () => {
  it("loads the bundled Claude Code profile by id", async () => {
    const profile = await loadProfile("claude-code");
    expect(profile).toMatchObject({ id: "claude-code", headless: { result_path: "result" }, schema: { result_path: "structured_output" } });
  });

  it("lists the bundled profiles", async () => {
    expect((await listBundledProfiles()).map((profile) => profile.id)).toEqual(["claude-code"]);
  });

  it("loads a profile by path and remembers its folder", async () => {
    const profile = await loadProfile(FAKE);
    expect(profile.id).toBe("fake-agent");
    expect(profile.dir).toBe(resolve("tests/fixtures/profiles"));
  });

  it("names an unknown profile id", async () => {
    await expect(loadProfile("no-such-agent")).rejects.toThrow("Unknown runtime profile 'no-such-agent'");
  });

  it.each([
    ["a headless command without {prompt}", { ...valid, headless: { ...valid.headless, cmd: ["x", "-p"] } }, /headless.cmd must contain \{prompt\}/],
    ["a schema flag without {schema_json}", { ...valid, schema: { flag: ["--s"], result_path: "r" } }, /schema.flag must contain \{schema_json\}/],
    ["a resume flag without {session_id}", { ...valid, resume: { flag: ["-r"] } }, /resume.flag must contain \{session_id\}/],
    ["an empty detect command", { ...valid, detect: { cmd: [], match: "X" } }, /detect.cmd must be a non-empty list of strings/],
    ["an unknown tos status", { ...valid, tos_review: { status: "maybe", note: "n" } }, /tos_review.status/],
    ["an id with capitals", { ...valid, id: "Claude" }, /id must be lowercase/],
    ["a placeholder the command cannot use", { ...valid, headless: { ...valid.headless, cmd: ["x", "-p", "{prompt}", "{session_id}"] } }, /headless.cmd uses \{session_id\}/],
  ])("refuses %s", (_name, raw, message) => {
    expect(() => parseProfile(raw, "/p")).toThrow(ProfileError);
    expect(() => parseProfile(raw, "/p")).toThrow(message);
  });

  it.each([
    ["2.1.294", "2.1.0", true],
    ["2.1.0", "2.1.0", true],
    ["2.0.99", "2.1.0", false],
    ["10.0.0", "9.9.9", true],
  ])("versionAtLeast(%s, %s) is %s", (actual, min, expected) => {
    expect(versionAtLeast(actual, min)).toBe(expected);
  });
});
```

Run: `npx vitest run tests/unit/profile.test.ts`
Expected: FAIL — `src/core/profile.ts` does not exist.

- [ ] **Step 3: Implement the loader**

Create `src/core/profile.ts`:

```ts
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

export interface RuntimeProfile {
  readonly id: string;
  readonly name: string;
  readonly min_version: string;
  readonly detect: { readonly cmd: readonly string[]; readonly match: string };
  readonly headless: { readonly cmd: readonly string[]; readonly result_path: string; readonly session_path: string; readonly error_path?: string };
  readonly schema?: { readonly flag: readonly string[]; readonly result_path: string };
  readonly resume?: { readonly flag: readonly string[] };
  readonly tos_review: { readonly status: "ok" | "pending" | "blocked"; readonly note: string };
  /** Folder the profile file was loaded from; fills {profile_dir} in commands. */
  readonly dir: string;
}

/** Bundled profiles ship in the package next to dist/ (src/core → ../../profiles, dist/core → ../../profiles). */
export const PROFILES_DIR = fileURLToPath(new URL("../../profiles/", import.meta.url));
const ID_PATTERN = /^[a-z0-9-]+$/;
const TOS_STATUSES = ["ok", "pending", "blocked"] as const;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

function str(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "") throw new ProfileError(`Profile ${where} must be a non-empty string`);
  return value;
}

/** Placeholders each command may use; anything else is an authoring error caught at load time, never at run time. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  "detect.cmd": ["profile_dir"],
  "headless.cmd": ["profile_dir", "prompt"],
  "schema.flag": ["schema_json"],
  "resume.flag": ["session_id"],
};

function argv(value: unknown, where: string, placeholder?: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((part) => typeof part === "string")) {
    throw new ProfileError(`Profile ${where} must be a non-empty list of strings`);
  }
  if (placeholder && !value.some((part: string) => part.includes(placeholder))) throw new ProfileError(`Profile ${where} must contain ${placeholder}`);
  const unknown = (value as string[]).flatMap((part) => [...part.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1])).find((name) => !(ALLOWED[where] ?? []).includes(name));
  if (unknown) throw new ProfileError(`Profile ${where} uses {${unknown}}, which it cannot use`);
  return value as string[];
}

function obj(value: unknown, where: string): Raw {
  if (!isRecord(value)) throw new ProfileError(`Profile ${where} must be an object`);
  return value;
}

function optionalParts(raw: Raw): Pick<RuntimeProfile, "schema" | "resume"> {
  const schema = raw.schema === undefined ? undefined : obj(raw.schema, "schema");
  const resume = raw.resume === undefined ? undefined : obj(raw.resume, "resume");
  return {
    ...(schema ? { schema: { flag: argv(schema.flag, "schema.flag", "{schema_json}"), result_path: str(schema.result_path, "schema.result_path") } } : {}),
    ...(resume ? { resume: { flag: argv(resume.flag, "resume.flag", "{session_id}") } } : {}),
  };
}

export function parseProfile(value: unknown, dir: string): RuntimeProfile {
  const raw = obj(value, "file");
  const id = str(raw.id, "id");
  if (!ID_PATTERN.test(id)) throw new ProfileError(`Profile id must be lowercase letters, digits and dashes, got '${id}'`);
  const detect = obj(raw.detect, "detect");
  const headless = obj(raw.headless, "headless");
  const tos = obj(raw.tos_review, "tos_review");
  if (!(TOS_STATUSES as readonly unknown[]).includes(tos.status)) throw new ProfileError(`Profile tos_review.status must be one of ${TOS_STATUSES.join(", ")}`);
  return {
    id,
    name: str(raw.name, "name"),
    min_version: str(raw.min_version, "min_version"),
    detect: { cmd: argv(detect.cmd, "detect.cmd"), match: str(detect.match, "detect.match") },
    headless: {
      cmd: argv(headless.cmd, "headless.cmd", "{prompt}"),
      result_path: str(headless.result_path, "headless.result_path"),
      session_path: str(headless.session_path, "headless.session_path"),
      ...(headless.error_path === undefined ? {} : { error_path: str(headless.error_path, "headless.error_path") }),
    },
    ...optionalParts(raw),
    tos_review: { status: tos.status as RuntimeProfile["tos_review"]["status"], note: str(tos.note, "tos_review.note") },
    dir,
  };
}

/** `ref` is a bundled profile id, or a path to a profile file (contains '/' or ends in .json). */
export async function loadProfile(ref: string): Promise<RuntimeProfile> {
  const isPath = ref.includes("/") || ref.endsWith(".json");
  if (!isPath && !ID_PATTERN.test(ref)) throw new ProfileError(`Unknown runtime profile '${ref}'`);
  const path = isPath ? resolve(ref) : join(PROFILES_DIR, `${ref}.json`);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ProfileError(`Unknown runtime profile '${ref}'`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProfileError(`Runtime profile '${ref}' is not valid JSON`);
  }
  return parseProfile(json, dirname(path));
}

export async function listBundledProfiles(): Promise<RuntimeProfile[]> {
  const names = (await readdir(PROFILES_DIR)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(names.map((name) => loadProfile(join(PROFILES_DIR, name))));
}

export function versionAtLeast(actual: string, min: string): boolean {
  const parts = (version: string): number[] => version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, m] = [parts(actual), parts(min)];
  for (let index = 0; index < Math.max(a.length, m.length); index += 1) {
    const diff = (a[index] ?? 0) - (m[index] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}
```

- [ ] **Step 4: Map `ProfileError` to exit 2 and ship the profiles**

In `src/cli.ts`, add `import { ProfileError } from "./core/profile.js";` and add `|| error instanceof ProfileError` to the `EXIT.USAGE` line of `exitCodeFor`.

In `package.json`, change `"files": ["dist"]` to `"files": ["dist", "profiles"]`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/unit/profile.test.ts && npm run typecheck`
Expected: PASS (15 tests); typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/core/profile.ts src/cli.ts package.json profiles tests/fixtures/profiles tests/unit/profile.test.ts
git commit -m "feat(core): load runtime profiles as JSON data"
```

---

### Task 3: Headless runner and fake agent

**Files:**
- Create: `src/core/headless.ts`, `tests/fakes/fake-agent.mjs`
- Test: `tests/unit/headless.test.ts` (new)

**Interfaces:**
- Consumes: `RuntimeProfile`, `ProfileError` (Task 2).
- Produces:
  - `HEADLESS_TIMEOUT_MS = 120_000`
  - `fillTemplate(argv: readonly string[], vars: Readonly<Record<string, string>>): string[]`
  - `runProcess(argv: readonly string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; error?: string }>`
  - `interface HeadlessRequest { prompt: string; schema?: object; sessionId?: string }`
  - `type HeadlessResult = { ok: true; text: string; structured?: unknown; sessionId?: string } | { ok: false; error: string }`
  - `interface HeadlessOptions { cwd: string; timeoutMs?: number }`
  - `runHeadless(profile, request, options): Promise<HeadlessResult>`
  - Fake agent protocol (used by Task 4's prompts): `Reply with exactly this word: <w>` → result `<w>`; `Remember this word: <w>. Reply OK.` → stores `<w>` for the session; any prompt with `-r <id>` → result is the stored word; with `--json-schema`, `structured_output = { word: <w> }` where `<w>` follows `in the field word: `. `FAKE_AGENT_DROP` = `c4` (exit 1), `json` (prints non-JSON), `schema` (no `structured_output`), `c5` (new session on resume), `hang` (never exits). `FAKE_AGENT_HOME` overrides where sessions are stored (default `./.fake-agent` in the working directory).

- [ ] **Step 1: Write the fake agent**

Create `tests/fakes/fake-agent.mjs`:

```js
#!/usr/bin/env node
// Test double for a headless agent CLI (shaped like `claude -p … --output-format json`).
// FAKE_AGENT_DROP switches off one capability: c4 | json | schema | c5 | hang.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const drop = process.env.FAKE_AGENT_DROP ?? "";
const store = process.env.FAKE_AGENT_HOME ?? join(process.cwd(), ".fake-agent");
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

function answer(prompt, resumed, session) {
  const exact = /Reply with exactly this word: (\S+)/.exec(prompt);
  if (exact) return exact[1];
  if (!resumed) return "OK";
  try {
    return readFileSync(join(store, `${session}.txt`), "utf8");
  } catch {
    return "I do not know";
  }
}

if (args[0] === "--version") {
  process.stdout.write("9.9.9 (Fake Agent)\n");
} else if (drop === "c4") {
  process.exit(1);
} else if (drop === "hang") {
  setInterval(() => undefined, 1000);
} else {
  const prompt = valueOf("-p") ?? "";
  const resumed = valueOf("-r");
  const session = resumed && drop !== "c5" ? resumed : randomUUID();
  mkdirSync(store, { recursive: true });
  const remember = /Remember this word: (\S+?)\./.exec(prompt);
  if (remember) writeFileSync(join(store, `${session}.txt`), remember[1]);
  const result = answer(prompt, resumed, session);
  const field = /in the field word: (\S+)/.exec(prompt);
  const structured = valueOf("--json-schema") && drop !== "schema" ? { structured_output: { word: field ? field[1] : result } } : {};
  const out = { result, session_id: session, is_error: false, ...structured };
  process.stdout.write(drop === "json" ? "this is not json" : JSON.stringify(out));
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/unit/headless.test.ts`:

```ts
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fillTemplate, runHeadless, runProcess } from "../../src/core/headless.js";
import { ProfileError, loadProfile } from "../../src/core/profile.js";
import { makeTempHome } from "../helpers/temp-home.js";

const FAKE = resolve("tests/fixtures/profiles/fake-agent.json");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("fillTemplate", () => {
  it("replaces placeholders inside tokens without rescanning the values", () => {
    expect(fillTemplate(["-p", "{prompt}", "x{a}y"], { prompt: "{a}", a: "1" })).toEqual(["-p", "{a}", "x1y"]);
  });

  it("refuses a placeholder that has no value", () => {
    expect(() => fillTemplate(["{nope}"], {})).toThrow(ProfileError);
  });
});

describe("runProcess", () => {
  it("names a command that is not installed (Review Focus 2)", async () => {
    const result = await runProcess(["installer-test-no-such-agent"], await makeTempHome(), 5_000);
    expect(result.error).toBe("'installer-test-no-such-agent' is not installed");
  });

  it("kills a command that runs past the timeout (Review Focus 1)", async () => {
    const result = await runProcess([process.execPath, "-e", "setInterval(() => {}, 1000)"], await makeTempHome(), 300);
    expect(result.error).toBe("timed out after 300 ms");
  });
});

describe("runHeadless against the fake agent", () => {
  it("returns the text and the session id", async () => {
    const result = await runHeadless(await loadProfile(FAKE), { prompt: "Reply with exactly this word: alpha" }, { cwd: await makeTempHome() });
    expect(result).toMatchObject({ ok: true, text: "alpha", sessionId: expect.any(String) });
  });

  it("returns structured output when a schema is given", async () => {
    const request = { prompt: "Put this word in the field word: beta", schema: { type: "object" } };
    const result = await runHeadless(await loadProfile(FAKE), request, { cwd: await makeTempHome() });
    expect(result).toMatchObject({ ok: true, structured: { word: "beta" } });
  });

  it("resumes a session", async () => {
    const profile = await loadProfile(FAKE);
    const cwd = await makeTempHome();
    const first = await runHeadless(profile, { prompt: "Remember this word: gamma. Reply OK." }, { cwd });
    if (!first.ok || !first.sessionId) throw new Error("first call failed");
    const second = await runHeadless(profile, { prompt: "What word did I ask you to remember?", sessionId: first.sessionId }, { cwd });
    expect(second).toMatchObject({ ok: true, text: "gamma", sessionId: first.sessionId });
  });

  it.each([
    ["c4", "exited with code 1"],
    ["json", "did not print JSON"],
  ])("reports FAKE_AGENT_DROP=%s as a failure, not a crash (Review Focus 1)", async (drop, error) => {
    vi.stubEnv("FAKE_AGENT_DROP", drop);
    const result = await runHeadless(await loadProfile(FAKE), { prompt: "Reply with exactly this word: x" }, { cwd: await makeTempHome() });
    expect(result).toEqual({ ok: false, error });
  });

  it("passes a prompt with shell syntax through literally and runs nothing (Review Focus 5)", async () => {
    const cwd = await makeTempHome();
    const word = "$(touch${IFS}pwned);`touch${IFS}pwned2`\"'";
    const result = await runHeadless(await loadProfile(FAKE), { prompt: `Reply with exactly this word: ${word}` }, { cwd });
    expect(result).toMatchObject({ ok: true, text: word });
    expect((await readdir(cwd)).filter((name) => name.startsWith("pwned"))).toEqual([]);
  });
});
```

Run: `npx vitest run tests/unit/headless.test.ts`
Expected: FAIL — `src/core/headless.ts` does not exist.

- [ ] **Step 3: Implement the runner**

Create `src/core/headless.ts`:

```ts
import { spawn } from "node:child_process";
import { ProfileError, type RuntimeProfile } from "./profile.js";

export const HEADLESS_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 1_000_000;

export interface HeadlessRequest {
  readonly prompt: string;
  readonly schema?: object;
  readonly sessionId?: string;
}

export type HeadlessResult =
  | { readonly ok: true; readonly text: string; readonly structured?: unknown; readonly sessionId?: string }
  | { readonly ok: false; readonly error: string };

export interface HeadlessOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
}

/** Fills {name} placeholders inside argv tokens. Values are inserted as-is and never rescanned. */
export function fillTemplate(argv: readonly string[], vars: Readonly<Record<string, string>>): string[] {
  return argv.map((token) =>
    token.replace(/\{([a-z_]+)\}/g, (whole, name: string) => {
      if (!Object.hasOwn(vars, name)) throw new ProfileError(`Profile placeholder '${whole}' has no value`);
      return vars[name];
    }),
  );
}

/** Spawns argv with no shell and no stdin; never rejects (Review Focus 1, 2, 5). */
export function runProcess(argv: readonly string[], cwd: string, timeoutMs: number): Promise<{ readonly stdout: string; readonly error?: string }> {
  const [file, ...args] = argv;
  return new Promise((done) => {
    const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let failure: string | undefined;
    const timer = setTimeout(() => {
      failure = `timed out after ${timeoutMs} ms`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_CHARS && !failure) {
        failure = "printed too much output";
        child.kill("SIGKILL");
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done({ stdout, error: error.code === "ENOENT" ? `'${file}' is not installed` : error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ stdout, ...(failure ? { error: failure } : code === 0 ? {} : { error: `exited with code ${code}` }) });
    });
  });
}

function pick(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (typeof node === "object" && node !== null ? (node as Record<string, unknown>)[key] : undefined), value);
}

function buildArgv(profile: RuntimeProfile, request: HeadlessRequest): string[] {
  const base = fillTemplate(profile.headless.cmd, { profile_dir: profile.dir, prompt: request.prompt });
  const schema = request.schema && profile.schema ? fillTemplate(profile.schema.flag, { schema_json: JSON.stringify(request.schema) }) : [];
  const resume = request.sessionId && profile.resume ? fillTemplate(profile.resume.flag, { session_id: request.sessionId }) : [];
  return [...base, ...schema, ...resume];
}

export async function runHeadless(profile: RuntimeProfile, request: HeadlessRequest, options: HeadlessOptions): Promise<HeadlessResult> {
  const { stdout, error } = await runProcess(buildArgv(profile, request), options.cwd, options.timeoutMs ?? HEADLESS_TIMEOUT_MS);
  if (error) return { ok: false, error };
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return { ok: false, error: "did not print JSON" };
  }
  if (profile.headless.error_path && pick(json, profile.headless.error_path) === true) return { ok: false, error: "reported an error" };
  const text = pick(json, profile.headless.result_path);
  if (typeof text !== "string") return { ok: false, error: `printed no text at '${profile.headless.result_path}'` };
  const sessionId = pick(json, profile.headless.session_path);
  const structured = request.schema && profile.schema ? pick(json, profile.schema.result_path) : undefined;
  return { ok: true, text, ...(typeof sessionId === "string" ? { sessionId } : {}), ...(structured === undefined ? {} : { structured }) };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/headless.test.ts && npm run typecheck`
Expected: PASS (10 tests); typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/core/headless.ts tests/fakes/fake-agent.mjs tests/unit/headless.test.ts
git commit -m "feat(core): call a host agent headless from a profile"
```

---

### Task 4: Probe, the `probe_runtime` action and `installer probe`

**Files:**
- Create: `src/core/probe.ts`
- Modify: `src/core/actions.ts` (actions return a `StatePatch`; add `probe_runtime`), `src/core/engine.ts` (`advance` merges the patch), `src/cli.ts` (`probe` command, `--profile` option)
- Test: `tests/unit/probe.test.ts` (new), `tests/e2e/cli.test.ts`

**Interfaces:**
- Consumes: `runHeadless`, `runProcess`, `fillTemplate`, `HEADLESS_TIMEOUT_MS` (Task 3); `RuntimeProfile`, `loadProfile`, `listBundledProfiles`, `versionAtLeast` (Task 2); `CapabilityMap`, `StatePatch`, `InstallState` (Task 1).
- Produces:
  - `interface ProbeOptions { profiles: readonly RuntimeProfile[]; cwd: string; timeoutMs?: number }`
  - `detectAgent(profiles, cwd): Promise<{ profile: RuntimeProfile; version: string | null } | null>`
  - `unknownRuntime(note: string): CapabilityMap`
  - `runProbe(options: ProbeOptions): Promise<CapabilityMap>`
  - `actions.ts`: `PROBE_DIR = join("runtime", "probe")`; `runAction(home, action, state?): Promise<StatePatch>`; auto action `probe_runtime` with optional `args.profile` (bundled id or path; without it, the bundled profiles are tried in order).
  - CLI: `installer probe [--profile <id|path>]` prints a `CapabilityMap`.

- [ ] **Step 1: Write the failing probe tests**

Create `tests/unit/probe.test.ts`:

```ts
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadProfile } from "../../src/core/profile.js";
import { runProbe } from "../../src/core/probe.js";
import { makeTempHome } from "../helpers/temp-home.js";

const FAKE = resolve("tests/fixtures/profiles/fake-agent.json");
const MISSING = resolve("tests/fixtures/profiles/missing-agent.json");

async function probe(drop?: string, timeoutMs?: number) {
  if (drop) vi.stubEnv("FAKE_AGENT_DROP", drop);
  return runProbe({ profiles: [await loadProfile(FAKE)], cwd: await makeTempHome(), ...(timeoutMs ? { timeoutMs } : {}) });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runProbe", () => {
  it("finds every capability on a working agent", async () => {
    expect(await probe()).toEqual({
      profile: "fake-agent", agent_version: "9.9.9", c2_shell: true, c4_headless: true, c4_schema: true, c5_resume: true,
      c6_mcp: "not_probed", support_level: 2, tier: "compatible", notes: [],
    });
  });

  it("records a missing structured output", async () => {
    expect(await probe("schema")).toMatchObject({ c4_headless: true, c4_schema: false, support_level: 2, notes: ["C4 schema: unexpected answer"] });
  });

  it("records a missing session resume", async () => {
    expect(await probe("c5")).toMatchObject({ c5_resume: false, support_level: 1, notes: ["C5 resume: unexpected answer"] });
  });

  it("records a failing headless call and skips the checks that need it", async () => {
    expect(await probe("c4")).toMatchObject({
      c4_headless: false, c4_schema: false, c5_resume: false, support_level: 0, tier: "unknown", notes: ["C4 headless: the agent exited with code 1"],
    });
  });

  it("records an agent that hangs as timed out (Review Focus 1)", async () => {
    expect(await probe("hang", 500)).toMatchObject({ c4_headless: false, notes: ["C4 headless: the agent timed out after 500 ms"] });
  });

  it("records an agent that prints non-JSON (Review Focus 1)", async () => {
    expect(await probe("json")).toMatchObject({ c4_headless: false, notes: ["C4 headless: the agent did not print JSON"] });
  });

  it("returns an unknown runtime when no profile's agent is installed (Review Focus 2)", async () => {
    const map = await runProbe({ profiles: [await loadProfile(MISSING)], cwd: await makeTempHome() });
    expect(map).toMatchObject({ profile: null, tier: "unknown", support_level: 0, notes: ["No known agent was found; fallbacks will apply"] });
  });

  it("uses the first profile whose agent is installed", async () => {
    const map = await runProbe({ profiles: [await loadProfile(MISSING), await loadProfile(FAKE)], cwd: await makeTempHome() });
    expect(map.profile).toBe("fake-agent");
  });
});
```

Run: `npx vitest run tests/unit/probe.test.ts`
Expected: FAIL — `src/core/probe.ts` does not exist.

- [ ] **Step 2: Implement the probe**

Create `src/core/probe.ts`:

```ts
import { randomBytes } from "node:crypto";
import { HEADLESS_TIMEOUT_MS, fillTemplate, runHeadless, runProcess, type HeadlessRequest, type HeadlessResult } from "./headless.js";
import { versionAtLeast, type RuntimeProfile } from "./profile.js";
import type { CapabilityMap } from "./types.js";

const DETECT_TIMEOUT_MS = 10_000;
const RECALL_PROMPT = "What word did I ask you to remember? Reply with the word only.";
const WORD_SCHEMA = { type: "object", properties: { word: { type: "string" } }, required: ["word"], additionalProperties: false };

export interface ProbeOptions {
  readonly profiles: readonly RuntimeProfile[];
  readonly cwd: string;
  readonly timeoutMs?: number;
}

interface ProbeCheck {
  readonly ok: boolean;
  readonly note?: string;
}

type Run = (request: HeadlessRequest) => Promise<HeadlessResult>;

const nonce = (): string => `w${randomBytes(4).toString("hex")}`;

function verdict(label: string, result: HeadlessResult, ok: boolean): ProbeCheck {
  if (ok) return { ok };
  return { ok, note: `${label}: ${result.ok ? "unexpected answer" : `the agent ${result.error}`}` };
}

async function checkHeadless(run: Run): Promise<ProbeCheck> {
  const word = nonce();
  const result = await run({ prompt: `Reply with exactly this word: ${word}` });
  return verdict("C4 headless", result, result.ok && result.text.includes(word));
}

async function checkSchema(run: Run): Promise<ProbeCheck> {
  const word = nonce();
  const result = await run({ prompt: `Put this word in the field word: ${word}`, schema: WORD_SCHEMA });
  const structured = result.ok ? result.structured : undefined;
  const ok = typeof structured === "object" && structured !== null && (structured as Record<string, unknown>).word === word;
  return verdict("C4 schema", result, ok);
}

async function checkResume(run: Run): Promise<ProbeCheck> {
  const word = nonce();
  const first = await run({ prompt: `Remember this word: ${word}. Reply OK.` });
  if (!first.ok || !first.sessionId) return verdict("C5 resume", first, false);
  const second = await run({ prompt: RECALL_PROMPT, sessionId: first.sessionId });
  return verdict("C5 resume", second, second.ok && second.text.includes(word) && second.sessionId === first.sessionId);
}

export async function detectAgent(profiles: readonly RuntimeProfile[], cwd: string): Promise<{ profile: RuntimeProfile; version: string | null } | null> {
  for (const profile of profiles) {
    const { stdout, error } = await runProcess(fillTemplate(profile.detect.cmd, { profile_dir: profile.dir }), cwd, DETECT_TIMEOUT_MS);
    if (error || !stdout.includes(profile.detect.match)) continue;
    return { profile, version: /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? null };
  }
  return null;
}

export function unknownRuntime(note: string): CapabilityMap {
  return {
    profile: null, agent_version: null, c2_shell: true, c4_headless: false, c4_schema: false, c5_resume: false,
    c6_mcp: "not_probed", support_level: 0, tier: "unknown", notes: [note],
  };
}

/** C2 holds by construction: the probe runs from the agent's shell and the agent reads its JSON back. */
export async function runProbe(options: ProbeOptions): Promise<CapabilityMap> {
  const found = await detectAgent(options.profiles, options.cwd);
  if (!found) return unknownRuntime("No known agent was found; fallbacks will apply");
  const { profile, version } = found;
  const run: Run = (request) => runHeadless(profile, request, { cwd: options.cwd, timeoutMs: options.timeoutMs ?? HEADLESS_TIMEOUT_MS });
  const skipped: ProbeCheck = { ok: false };
  const headless = await checkHeadless(run);
  const schema = headless.ok && profile.schema ? await checkSchema(run) : skipped;
  const resume = headless.ok && profile.resume ? await checkResume(run) : skipped;
  const versionOk = version !== null && versionAtLeast(version, profile.min_version);
  const notes = [
    ...(versionOk ? [] : [`${profile.name} ${version ?? "(unknown version)"} is older than the supported ${profile.min_version}`]),
    ...[headless, schema, resume].flatMap((check) => (check.note ? [check.note] : [])),
  ];
  return {
    profile: profile.id, agent_version: version, c2_shell: true,
    c4_headless: headless.ok, c4_schema: schema.ok, c5_resume: resume.ok, c6_mcp: "not_probed",
    support_level: [headless.ok, resume.ok].filter(Boolean).length,
    tier: headless.ok && versionOk ? "compatible" : "unknown",
    notes,
  };
}
```

Run: `npx vitest run tests/unit/probe.test.ts` — Expected: PASS (8 tests).

- [ ] **Step 3: Write the failing engine and CLI tests**

Add to `tests/e2e/cli.test.ts` (it already imports `writeFile`, `join`, `resolve`, `loadState` and `makeTempHome`):

```ts
  describe("runtime probe", () => {
    const FAKE_PROFILE = resolve("tests/fixtures/profiles/fake-agent.json");

    async function probeSolution(): Promise<string> {
      const path = join(await makeTempHome(), "probe.json");
      const steps = [
        { step_id: "preflight.probe", phase: "PREFLIGHT", type: "auto", title: "Check the agent", why: "Finds what the agent can do.", blocking: true, auto: { action: "probe_runtime", args: { profile: FAKE_PROFILE } } },
        { step_id: "report.final", phase: "REPORT", type: "auto", title: "Finish", why: "Marks the end.", blocking: true, auto: { action: "noop" } },
      ];
      await writeFile(path, JSON.stringify({ id: "probe-only", version: "1.0.0", steps }), "utf8");
      return `file:${path}`;
    }

    it("installer probe prints the capability map", () => {
      const result = runCli(["probe", "--profile", FAKE_PROFILE], {});
      expect(result.code).toBe(0);
      expect(result.json).toMatchObject({ profile: "fake-agent", c4_headless: true, c5_resume: true, support_level: 2 });
    });

    it("installer probe names an unknown profile, exit 2", () => {
      const result = runCli(["probe", "--profile", "no-such-agent"], {});
      expect(result.code).toBe(2);
      expect(result.json).toMatchObject({ error: "Unknown runtime profile 'no-such-agent'" });
    });

    it("the probe_runtime step stores the capability map in the state", async () => {
      const home = await makeTempHome();
      expect(runCli(["start", "--solution", await probeSolution()], { home }).json).toEqual({ status: "complete" });
      expect((await loadState(home))?.runtime).toMatchObject({ profile: "fake-agent", support_level: 2 });
    });

    it("a kill right after the probe runs it again on resume and keeps one result", async () => {
      const home = await makeTempHome();
      const crashed = runCli(["start", "--solution", await probeSolution()], { home, env: { INSTALLER_CRASH_AT: "engine:after-action" } });
      expect(crashed.signal).toBe("SIGKILL");
      expect((await loadState(home))?.runtime).toBeUndefined();
      expect(runCli(["resume"], { home }).json).toEqual({ status: "complete" });
      expect((await loadState(home))?.runtime).toMatchObject({ profile: "fake-agent" });
    });
  });
```

In the same file, update the unknown-option test's expected message to include the new option:

```ts
    expect(result.json).toEqual({ error: `Unknown option '${raw}'. Options: --home, --solution, --value, --done, --json, --profile`, code: 2 });
```

Run: `npx vitest run tests/e2e/cli.test.ts`
Expected: FAIL — `probe` is an unknown command, `probe_runtime` an unknown action.

- [ ] **Step 4: Let actions return a state patch and add `probe_runtime`**

In `src/core/actions.ts`:

1. Change the imports to:

```ts
import { access, lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative as relativePath, resolve, sep } from "node:path";
import { InputError } from "./inputs.js";
import { listBundledProfiles, loadProfile } from "./profile.js";
import { runProbe } from "./probe.js";
import type { Action, Check, InstallState, StatePatch } from "./types.js";
```

2. Replace the `ACTIONS` table and `runAction` with:

```ts
/** Working folder for headless agent calls made by the probe, inside the engine home (D34). */
export const PROBE_DIR = join("runtime", "probe");

type ActionRun = (home: string, args: Args, state: InstallState | undefined) => Promise<StatePatch>;

const ACTIONS: Readonly<Record<string, ActionRun>> = {
  noop: async () => ({}),
  write_file: async (home, args) => {
    const target = await confinedPath(home, stringArg(args, "path"));
    const content = args.content === undefined ? "" : stringArg(args, "content");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
    return {};
  },
  probe_runtime: async (home, args) => {
    const cwd = await confinedPath(home, PROBE_DIR);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const profiles = typeof args.profile === "string" ? [await loadProfile(args.profile)] : await listBundledProfiles();
    return { runtime: await runProbe({ profiles, cwd }) };
  },
};
```

```ts
export async function runAction(home: string, action: Action, state?: InstallState): Promise<StatePatch> {
  if (!Object.hasOwn(ACTIONS, action.action)) throw new InputError(`Unknown action '${action.action}'`);
  const run = ACTIONS[action.action];
  return run(home, action.args ?? {}, state);
}
```

3. In `src/core/engine.ts` `advance`, replace the auto branch with:

```ts
    if (step.type === "auto" && step.auto) {
      const patch = await runAction(deps.home, step.auto, current);
      crashPoint("engine:after-action");
      current = await transition(deps, { ...current, ...patch }, step, { status: "done", at: deps.now(), by: "engine" }, "engine");
      continue;
    }
```

- [ ] **Step 5: Add `installer probe`**

In `src/cli.ts`:

1. Change the fs import to `import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";`, the os import to `import { homedir, tmpdir } from "node:os";`, and add:

```ts
import { ProfileError, listBundledProfiles, loadProfile } from "./core/profile.js";
import { runProbe } from "./core/probe.js";
import type { CapabilityMap, InstallState, Solution } from "./core/types.js";
```

(merge `ProfileError` into the import added in Task 2; replace the existing `types.js` import).

2. Change `COMMANDS` to `"start, next, submit, verify, resume, report, probe"`, add `readonly profile?: string;` to `Flags`, and add `profile: { type: "string" }` at the end of `OPTIONS`.

3. Add:

```ts
/** Runs the probe in a throwaway folder; it reads no install and writes no state. */
async function probeCommand(flags: Flags): Promise<CapabilityMap> {
  const cwd = await mkdtemp(join(tmpdir(), "installer-probe-"));
  try {
    const profiles = flags.profile ? [await loadProfile(flags.profile)] : await listBundledProfiles();
    return await runProbe({ profiles, cwd });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
```

4. In `run`, right after the `start` branch:

```ts
  if (command === "probe") {
    emit(process.stdout, await probeCommand(flags));
    return EXIT.OK;
  }
```

- [ ] **Step 6: Let the neutrality guard accept the JSON Schema keyword**

`probe.ts` contains the JSON Schema key `properties:`, which `tests/unit/neutrality.test.ts` bans as the real-estate word "property". Exempt only the schema key form. In `tests/unit/neutrality.test.ts`, change `BANNED` to:

```ts
const BANNED = /\b(tenants?|landlords?|realtors?|leases?|rent|rental|mortgages?|propert(y|ies)(?!\s*:)|listings?|brokerages?)\b/i;
```

- [ ] **Step 7: Run the whole suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck exits 0; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/core/probe.ts src/core/actions.ts src/core/engine.ts src/cli.ts tests/unit/probe.test.ts tests/unit/neutrality.test.ts tests/e2e/cli.test.ts
git commit -m "feat(core): probe the host agent and store its capabilities"
```

---

### Task 5: Report the runtime

**Files:**
- Modify: `src/core/report.ts`
- Test: `tests/unit/report.test.ts`

**Interfaces:**
- Consumes: `CapabilityMap`, `InstallState.runtime` (Task 1).
- Produces: `Report.runtime: CapabilityMap | null`, `Report.runtime_limits: readonly string[]`, `runtimeLimits(runtime?: CapabilityMap): readonly string[]`. A probed limit turns an otherwise finished install into `ready_with_limits` (R5). `c6_mcp: "not_probed"` is shown but is not a limit.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/report.test.ts` (it already has `allDone`, `basicSolution`, `buildReport`, `renderReport`):

```ts
describe("runtime line", () => {
  const runtime = {
    profile: "claude-code", agent_version: "2.1.294", c2_shell: true, c4_headless: true, c4_schema: true, c5_resume: true,
    c6_mcp: "not_probed", support_level: 2, tier: "compatible", notes: [],
  } as const;

  it("shows the agent and keeps a full runtime READY", () => {
    const report = buildReport(basicSolution(), { ...allDone(), runtime });
    expect(report.overall).toBe("ready");
    expect(report.runtime_limits).toEqual([]);
    expect(renderReport(report).split("\n")[2]).toBe("🤖 Agent      claude-code 2.1.294 — level 2 of 3 (MCP not checked yet)");
  });

  it("turns a missing capability into READY WITH LIMITS", () => {
    const report = buildReport(basicSolution(), { ...allDone(), runtime: { ...runtime, c5_resume: false, support_level: 1 } });
    expect(report.overall).toBe("ready_with_limits");
    expect(report.runtime_limits).toEqual(["no session resume"]);
  });

  it("says fallbacks apply when no agent was recognised (Review Focus 2)", () => {
    const unknown = { ...runtime, profile: null, agent_version: null, c4_headless: false, c4_schema: false, c5_resume: false, support_level: 0, tier: "unknown" } as const;
    const report = buildReport(basicSolution(), { ...allDone(), runtime: unknown });
    expect(report.overall).toBe("ready_with_limits");
    expect(renderReport(report)).toContain("🤖 Agent      unknown agent — level 0 of 3 (no known agent profile; fallbacks apply, MCP not checked yet)");
  });

  it("prints no agent line before the probe has run", () => {
    const report = buildReport(basicSolution(), allDone());
    expect(report.runtime).toBeNull();
    expect(renderReport(report)).not.toContain("Agent");
  });
});
```

Run: `npx vitest run tests/unit/report.test.ts`
Expected: FAIL — `runtime_limits` is undefined.

- [ ] **Step 2: Implement**

In `src/core/report.ts`:

1. Change the types import to `import type { CapabilityMap, InstallState, Phase, Solution, StepDef, StepRecord } from "./types.js";`.

2. Add to `Report`:

```ts
  readonly runtime: CapabilityMap | null;
  readonly runtime_limits: readonly string[];
```

3. Add before `buildReport`:

```ts
/** Limits the probe actually found (R5). An MCP check that has not run yet is not a limit. */
export function runtimeLimits(runtime: CapabilityMap | undefined): readonly string[] {
  if (!runtime) return [];
  if (!runtime.profile) return ["no known agent profile; fallbacks apply"];
  return [
    ...(runtime.c4_headless ? [] : ["no headless calls"]),
    ...(runtime.c4_headless && !runtime.c4_schema ? ["no structured output"] : []),
    ...(runtime.c5_resume ? [] : ["no session resume"]),
  ];
}
```

4. In `buildReport`, replace the `overall` line and the `return` with:

```ts
  const limits = runtimeLimits(state.runtime);
  const overall: Overall =
    hardBlocked.length > 0 ? "blocked" : current ? "in_progress" : limited.length > 0 || limits.length > 0 ? "ready_with_limits" : "ready";
  return {
    overall, solution: `${solution.id}@${solution.version}`, phase: current?.phase ?? null, done: working.length, total: solution.steps.length,
    working, limited, needs_you, runtime: state.runtime ?? null, runtime_limits: limits,
  };
```

5. Add before `renderReport`:

```ts
function agentLine(report: Report): string | null {
  const runtime = report.runtime;
  if (!runtime) return null;
  const name = runtime.profile ? `${runtime.profile} ${runtime.agent_version ?? ""}`.trim() : "unknown agent";
  const missing = [...report.runtime_limits, ...(runtime.c6_mcp === "not_probed" ? ["MCP not checked yet"] : [])];
  return `🤖 Agent      ${name} — level ${runtime.support_level} of 3${missing.length > 0 ? ` (${missing.join(", ")})` : ""}`;
}
```

6. In `renderReport`, after the `✅ Working` line, add:

```ts
  const agent = agentLine(report);
  if (agent) lines.push(agent);
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run tests/unit/report.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/core/report.ts tests/unit/report.test.ts
git commit -m "feat(core): show the probed agent in the report"
```

---

### Task 6: MODE phase

**Files:**
- Create: `src/core/mode.ts`
- Modify: `src/core/actions.ts` (add `derive_mode`), `src/core/solution.ts` (reference check)
- Test: `tests/unit/mode.test.ts` (new)

**Interfaces:**
- Consumes: `runAction(home, action, state)` returning `StatePatch` (Task 4); `Mode`, `Roles` (Task 1).
- Produces:
  - `MODE_ARGS = ["shared_work", "always_on", "decision_maker"] as const`
  - `deriveMode(sharedWork: unknown, alwaysOn: unknown): Mode` — answers: shared work `no | yes | both`, always on `no | yes`. `both` → `hybrid`; `no` + `no` → `personal`; anything else → `team_host` (spec §5).
  - `deriveModeAction(args, state): StatePatch` → `{ mode, roles: { decision_maker } }`.
  - Auto action `derive_mode` with `args: { shared_work: <ask step id>, always_on: <ask step id>, decision_maker: <ask step id> }`. Each must name an **earlier `ask` step**; checked when the solution loads.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/mode.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runAction } from "../../src/core/actions.js";
import { start, submit } from "../../src/core/engine.js";
import { InputError } from "../../src/core/inputs.js";
import { deriveMode } from "../../src/core/mode.js";
import { SolutionError, parseSolution } from "../../src/core/solution.js";
import { memoryDeps } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const ask = (step_id: string, input: object) => ({ step_id, phase: "MODE", type: "ask", title: step_id, why: "Needed.", blocking: true, input });
const derive = (args: object) => ({ step_id: "mode.derive", phase: "MODE", type: "auto", title: "Work out the mode", why: "Sets up the right shape.", blocking: true, auto: { action: "derive_mode", args } });
const ARGS = { shared_work: "q1", always_on: "q2", decision_maker: "q3" };
const QUESTIONS = [ask("q1", { kind: "choice", options: ["no", "yes", "both"] }), ask("q2", { kind: "choice", options: ["no", "yes"] }), ask("q3", { kind: "text" })];

describe("deriveMode (spec §5)", () => {
  it.each([
    ["no", "no", "personal"],
    ["yes", "no", "team_host"],
    ["no", "yes", "team_host"],
    ["yes", "yes", "team_host"],
    ["both", "no", "hybrid"],
    ["both", "yes", "hybrid"],
  ])("shared work %s, always on %s → %s", (shared, alwaysOn, mode) => {
    expect(deriveMode(shared, alwaysOn)).toBe(mode);
  });

  it.each([["maybe", "no"], ["yes", "sometimes"]])("refuses the answers %s / %s", (shared, alwaysOn) => {
    expect(() => deriveMode(shared, alwaysOn)).toThrow(InputError);
  });
});

describe("derive_mode in an install", () => {
  it("stores the mode and the decision maker after the three answers", async () => {
    const solution = parseSolution({ id: "m", version: "1", steps: [...QUESTIONS, derive(ARGS)] });
    const { deps } = memoryDeps(await makeTempHome(), solution);
    let { state } = await start(deps, null, "file:/m.json");
    state = (await submit(deps, state, "q1", { kind: "value", value: "yes" })).state;
    state = (await submit(deps, state, "q2", { kind: "value", value: "no" })).state;
    const last = await submit(deps, state, "q3", { kind: "value", value: "  Office manager " });
    expect(last.result).toEqual({ status: "complete" });
    expect(last.state).toMatchObject({ mode: "team_host", roles: { decision_maker: "Office manager" } });
  });

  it("refuses to run before its answers exist", async () => {
    await expect(runAction(await makeTempHome(), { action: "derive_mode", args: ARGS })).rejects.toThrow("derive_mode needs step 'q1' to be answered first");
  });

  it.each([
    ["a step that does not exist", { ...ARGS, shared_work: "q9" }, [...QUESTIONS, derive({ ...ARGS, shared_work: "q9" })]],
    ["a step that comes after it", ARGS, [QUESTIONS[0], QUESTIONS[1], derive(ARGS), QUESTIONS[2]]],
    ["a missing argument", { shared_work: "q1", always_on: "q2" }, [...QUESTIONS, derive({ shared_work: "q1", always_on: "q2" })]],
  ])("refuses a solution whose derive_mode names %s (Review Focus 4)", (_name, _args, steps) => {
    expect(() => parseSolution({ id: "m", version: "1", steps })).toThrow(SolutionError);
    expect(() => parseSolution({ id: "m", version: "1", steps })).toThrow(/derive_mode args\.\w+ must name an earlier ask step/);
  });
});
```

Run: `npx vitest run tests/unit/mode.test.ts`
Expected: FAIL — `src/core/mode.ts` does not exist.

- [ ] **Step 2: Implement `mode.ts`**

Create `src/core/mode.ts`:

```ts
import { InputError } from "./inputs.js";
import type { InstallState, Mode, StatePatch } from "./types.js";

export const MODE_ARGS = ["shared_work", "always_on", "decision_maker"] as const;
const SHARED_ANSWERS: readonly unknown[] = ["no", "yes", "both"];
const ALWAYS_ON_ANSWERS: readonly unknown[] = ["no", "yes"];

/** Spec §5: shared and personal work → hybrid; neither shared nor always-on → personal; otherwise team host. */
export function deriveMode(sharedWork: unknown, alwaysOn: unknown): Mode {
  if (!SHARED_ANSWERS.includes(sharedWork)) throw new InputError(`Shared work must be no, yes or both, got ${JSON.stringify(sharedWork)}`);
  if (!ALWAYS_ON_ANSWERS.includes(alwaysOn)) throw new InputError(`Always-on must be no or yes, got ${JSON.stringify(alwaysOn)}`);
  if (sharedWork === "both") return "hybrid";
  return sharedWork === "no" && alwaysOn === "no" ? "personal" : "team_host";
}

function answerOf(state: InstallState | undefined, args: Readonly<Record<string, unknown>>, key: string): unknown {
  const stepId = args[key];
  if (typeof stepId !== "string") throw new InputError(`derive_mode needs args.${key}, the id of the step that asks it`);
  const record = state?.steps[stepId];
  if (record?.status !== "done") throw new InputError(`derive_mode needs step '${stepId}' to be answered first`);
  return record.value;
}

export function deriveModeAction(args: Readonly<Record<string, unknown>>, state: InstallState | undefined): StatePatch {
  const sharedWork = answerOf(state, args, "shared_work");
  const alwaysOn = answerOf(state, args, "always_on");
  const decisionMaker = answerOf(state, args, "decision_maker");
  if (typeof decisionMaker !== "string" || decisionMaker.trim() === "") throw new InputError("The decision maker answer must be a name or a role");
  return { mode: deriveMode(sharedWork, alwaysOn), roles: { decision_maker: decisionMaker.trim() } };
}
```

- [ ] **Step 3: Register the action and check references at load time**

In `src/core/actions.ts`, add `import { deriveModeAction } from "./mode.js";` and add to `ACTIONS`:

```ts
  derive_mode: async (_home, args, state) => deriveModeAction(args, state),
```

In `src/core/solution.ts`, add `import { MODE_ARGS } from "./mode.js";`, add this function before `parseSolution`:

```ts
/** derive_mode reads earlier answers; refuse a solution whose references point nowhere (Review Focus 4). */
function checkModeReferences(steps: readonly StepDef[]): void {
  steps.forEach((step, index) => {
    if (step.auto?.action !== "derive_mode") return;
    const earlierAsks = new Set(steps.slice(0, index).filter((earlier) => earlier.type === "ask").map((earlier) => earlier.step_id));
    for (const key of MODE_ARGS) {
      const ref = step.auto.args?.[key];
      if (typeof ref !== "string" || !earlierAsks.has(ref)) {
        throw new SolutionError(`Step '${step.step_id}': derive_mode args.${key} must name an earlier ask step, got ${JSON.stringify(ref ?? null)}`);
      }
    }
  });
}
```

and call `checkModeReferences(steps);` in `parseSolution` just before `return { id, version, steps };`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/mode.test.ts && npm run typecheck && npx vitest run`
Expected: PASS (13 tests in `mode.test.ts`); typecheck exits 0; the whole suite passes.

- [ ] **Step 5: Commit**

```bash
git add src/core/mode.ts src/core/actions.ts src/core/solution.ts tests/unit/mode.test.ts
git commit -m "feat(core): derive the deployment mode from three answers"
```

---

### Task 7: Per-runtime hints and the retry command of a reopened step

**Files:**
- Modify: `src/core/solution.ts` (parse `hints`), `src/core/engine.ts` (`StepView.hints`, `viewOf`)
- Test: `tests/unit/hints.test.ts` (new)

**Interfaces:**
- Consumes: `StepDef.hints` (Task 1), `InstallState.runtime.profile` (Task 4).
- Produces: `StepView.hints?: readonly string[]` — the lines for the probed profile only. A pending step with `attempts > 0` (reopened by `resume`) shows `retryCommand(step)` in `view.resume`, so a reopened `agent_action` says `installer verify <step_id>` (carried forward from Plan 1).

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/hints.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { advance, resume, start, submit, verifyStep } from "../../src/core/engine.js";
import { SolutionError, parseSolution } from "../../src/core/solution.js";
import type { CapabilityMap } from "../../src/core/types.js";
import { FIXTURE_REF, basicSolution, memoryDeps } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const agentStep = (hints: unknown) => ({
  step_id: "brain.do", phase: "BRAIN", type: "agent_action", title: "Do it", why: "Needed.", blocking: true,
  intent: "Create config/done.txt", verify: { check: "file_exists", args: { path: "config/done.txt" } }, hints,
});
const runtime = (profile: string | null): CapabilityMap => ({
  profile, agent_version: "1.0.0", c2_shell: true, c4_headless: true, c4_schema: true, c5_resume: true,
  c6_mcp: "not_probed", support_level: 2, tier: "compatible", notes: [],
});
const HINTS = { "claude-code": ["Use the Write tool.", "Then run the verify command."] };

async function viewWith(profile: string | null | undefined) {
  const solution = parseSolution({ id: "h", version: "1", steps: [agentStep(HINTS)] });
  const { deps } = memoryDeps(await makeTempHome(), solution);
  const { state } = await start(deps, null, "file:/h.json");
  const withRuntime = profile === undefined ? state : { ...state, runtime: runtime(profile) };
  return (await advance(deps, withRuntime)).result;
}

describe("hints", () => {
  it("shows the hints for the probed agent", async () => {
    expect(await viewWith("claude-code")).toMatchObject({ status: "step", view: { hints: HINTS["claude-code"] } });
  });

  it.each([["another agent", "codex"], ["an unknown agent", null], ["no probe yet", undefined]])("shows no hints for %s", async (_name, profile) => {
    const result = await viewWith(profile);
    expect(result.status === "step" && result.view.hints).toBeFalsy();
  });

  it.each([
    ["a profile id with spaces", { "claude code": ["x"] }],
    ["an empty list", { "claude-code": [] }],
    ["a non-object", ["x"]],
  ])("refuses %s", (_name, hints) => {
    expect(() => parseSolution({ id: "h", version: "1", steps: [agentStep(hints)] })).toThrow(SolutionError);
  });
});

describe("a reopened agent_action", () => {
  it("names installer verify, not installer resume", async () => {
    const { deps } = memoryDeps(await makeTempHome(), basicSolution());
    let { state } = await start(deps, null, FIXTURE_REF);
    state = (await submit(deps, state, "mode.shared-work", { kind: "value", value: "yes" })).state;
    state = (await submit(deps, state, "mode.report-time", { kind: "value", value: "09:00" })).state;
    state = (await verifyStep(deps, state, "brain.register")).state;
    const reopened = await resume(deps, state);
    expect(reopened.result).toMatchObject({ status: "step", view: { status: "pending", attempts: 1, resume: "installer verify brain.register" } });
  });
});
```

Run: `npx vitest run tests/unit/hints.test.ts`
Expected: FAIL — hints are dropped by the parser, and the reopened step shows `installer resume`.

- [ ] **Step 2: Parse hints**

In `src/core/solution.ts`, add before `optionalFields`:

```ts
const PROFILE_ID = /^[a-z0-9-]+$/;

/** Per-runtime lines for an agent_action, keyed by runtime profile id (D7 hint files). */
function parseHints(value: unknown, where: string): Readonly<Record<string, readonly string[]>> {
  if (!isRecord(value)) throw new SolutionError(`${where} must map runtime profile ids to lists of lines`);
  return Object.fromEntries(
    Object.entries(value).map(([id, lines]) => {
      if (!PROFILE_ID.test(id) || !Array.isArray(lines) || lines.length === 0) throw new SolutionError(`${where}.${id} must be a non-empty list of lines`);
      return [id, lines.map((line) => text(line, `${where}.${id}`))];
    }),
  );
}
```

In `optionalFields`, add `"hints"` to both `Pick<StepDef, …>` lists and add before the `return`:

```ts
  if (value.hints !== undefined) {
    result.hints = parseHints(value.hints, `${where}.hints`);
  }
```

- [ ] **Step 3: Show hints and the right retry command**

In `src/core/engine.ts`, add `readonly hints?: readonly string[];` to `StepView`, replace `viewOf` with:

```ts
function viewOf(step: StepDef, record: StepRecord | undefined, profile?: string | null): StepView {
  const hints = profile ? step.hints?.[profile] : undefined;
  const retrying = record?.status === "failed" || (record?.status === "pending" && (record.attempts ?? 0) > 0);
  return {
    step,
    status: record?.status ?? "pending",
    attempts: record?.attempts ?? 0,
    ...(record?.hint ? { hint: record.hint } : {}),
    ...(hints ? { hints } : {}),
    resume: retrying ? retryCommand(step) : RESUME_HINT,
  };
}
```

and in `advance` change both `viewOf(step, record)` calls to `viewOf(step, record, current.runtime?.profile)`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/hints.test.ts && npm run typecheck && npx vitest run`
Expected: PASS (8 tests in `hints.test.ts`); typecheck exits 0; the whole suite passes.

- [ ] **Step 5: Commit**

```bash
git add src/core/solution.ts src/core/engine.ts tests/unit/hints.test.ts
git commit -m "feat(core): show per-agent hints and the right retry command"
```

---

### Task 8: `INSTALL.md`, the starter solution and an end-to-end install

**Files:**
- Create: `INSTALL.md`, `solutions/starter.json`, `tests/fixtures/solution-starter.json`, `tests/e2e/install-doc.test.ts`
- Modify: `tests/operator/scripted-operator.ts` (`STARTER_REF`, `STARTER_SCRIPT`), `tests/unit/neutrality.test.ts`, `package.json` (`files`)

**Interfaces:**
- Consumes: everything above; `operate()` from the scripted operator.
- Produces: `INSTALL.md` with the placeholders `{{INSTALL_COMMAND}}` and `{{SOLUTION_REF}}` (filled by whoever serves the solution; the package name is still open item O8); `solutions/starter.json` (probe with bundled profiles + MODE + final marker); `STARTER_REF`, `STARTER_SCRIPT`.

- [ ] **Step 1: Write the starter solutions**

Create `solutions/starter.json`:

```json
{
  "id": "starter",
  "version": "1.0.0",
  "steps": [
    { "step_id": "preflight.probe", "phase": "PREFLIGHT", "type": "auto", "title": "Check what your agent can do", "why": "Later steps adapt to what your agent supports.", "blocking": true,
      "auto": { "action": "probe_runtime" } },
    { "step_id": "mode.shared-work", "phase": "MODE", "type": "ask", "title": "Is there shared work, such as a shared inbox, customer list or team reports?", "why": "Shared work needs one machine the whole team uses.", "blocking": true,
      "input": { "kind": "choice", "options": ["no", "yes", "both"] } },
    { "step_id": "mode.always-on", "phase": "MODE", "type": "ask", "title": "Must anything run when every laptop is closed?", "why": "Scheduled jobs and round-the-clock replies need a machine that stays on.", "blocking": true,
      "input": { "kind": "choice", "options": ["no", "yes"] } },
    { "step_id": "mode.decision-maker", "phase": "MODE", "type": "ask", "title": "Who is the decision maker?", "why": "This person approves important actions and receives urgent alerts.", "blocking": true,
      "input": { "kind": "text" } },
    { "step_id": "mode.derive", "phase": "MODE", "type": "auto", "title": "Choose the setup", "why": "Your answers decide between a personal, team host or hybrid setup.", "blocking": true,
      "auto": { "action": "derive_mode", "args": { "shared_work": "mode.shared-work", "always_on": "mode.always-on", "decision_maker": "mode.decision-maker" } } },
    { "step_id": "report.final", "phase": "REPORT", "type": "auto", "title": "Finish the install", "why": "Marks the install as finished.", "blocking": true,
      "auto": { "action": "write_file", "args": { "path": "config/finished.txt", "content": "done\n" } } }
  ]
}
```

Create `tests/fixtures/solution-starter.json` with the same content except the first step's action, which points at the fake agent:

```json
      "auto": { "action": "probe_runtime", "args": { "profile": "tests/fixtures/profiles/fake-agent.json" } } },
```

and `"id": "fixture-starter"`.

- [ ] **Step 2: Write `INSTALL.md`**

Create `INSTALL.md`:

````markdown
# Install this solution

You are the operator of this install. A person asked you to install a solution. Follow these steps exactly.

## 1. Install the installer

```bash
{{INSTALL_COMMAND}}
```

## 2. Start the install

```bash
installer start --solution {{SOLUTION_REF}}
```

## 3. Repeat until the install is finished or blocked

Every command prints one line of JSON. Read its `status`:

- `"step"`: act on `view.step` by its `type`.
  - `ask`: ask the person the step's `title` and tell them its `why`. Then run `installer submit <step_id> --value '<json>'`. Text answers are JSON strings, for example `--value '"North team"'`. A value that starts with `-` uses the `=` form: `--value=-5`.
  - `human_action`: tell the person the `instructions` and the `why`, and wait until they say it is done. Then run `installer verify <step_id>` if the step has a `verify`, otherwise `installer submit <step_id> --done`.
  - `agent_action`: do the `intent` yourself, following `view.hints` when present. Then run `installer verify <step_id>`.
- `"failed"` or `"blocked"`: tell the person the `hint` and the command in `view.resume`. Stop and wait for them.
- `"complete"`: run `installer report` and show it to the person.

`installer next` shows the current step again. `installer report` shows progress. After a break of minutes or days, `installer resume` continues where the install stopped.

## Operator rules

1. Never invent an answer on the person's behalf; ask.
2. Always tell the person why a step is needed (from the step's `why`).
3. Never request, repeat or store secrets in chat. Keys and sign-ins are entered on a page the installer opens on this computer, never through you.
4. At a blocking human step, stop; state exactly what to do and how to resume (`installer resume`).
5. After every `agent_action`, run the step's verify (`installer verify <step_id>`).
````

- [ ] **Step 3: Add the operator script**

In `tests/operator/scripted-operator.ts`, add after `GIVE_UP_SCRIPT`:

```ts
export const STARTER_REF = `file:${resolve("tests/fixtures/solution-starter.json")}`;

export const STARTER_SCRIPT: OperatorScript = {
  answers: { "mode.shared-work": "yes", "mode.always-on": "no", "mode.decision-maker": "Owner" },
  perform: {},
};
```

- [ ] **Step 4: Write the failing tests**

Create `tests/e2e/install-doc.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSolution } from "../../src/core/solution.js";
import { loadState } from "../../src/core/state.js";
import { runCli } from "../helpers/cli.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { STARTER_REF, STARTER_SCRIPT, operate } from "../operator/scripted-operator.js";

const DOC = readFileSync("INSTALL.md", "utf8");
const COMMANDS = ["start", "next", "submit", "verify", "resume", "report", "probe"];

describe("INSTALL.md", () => {
  it("states the five operator rules from spec §6.1", () => {
    for (const rule of ["1. Never invent an answer", "2. Always tell the person why", "3. Never request, repeat or store secrets", "4. At a blocking human step, stop", "5. After every `agent_action`, run the step's verify"]) {
      expect(DOC).toContain(rule);
    }
  });

  it("has the two placeholders the solution server fills in", () => {
    expect(DOC).toContain("{{INSTALL_COMMAND}}");
    expect(DOC).toContain("installer start --solution {{SOLUTION_REF}}");
  });

  it("only names commands the CLI has", () => {
    const named = [...DOC.matchAll(/(?:^|`)installer (\w+)/gm)].map((match) => match[1]);
    expect(named.filter((name) => !COMMANDS.includes(name))).toEqual([]);
  });

  it("the shipped starter solution loads and probes with the bundled profiles", () => {
    const starter = parseSolution(JSON.parse(readFileSync("solutions/starter.json", "utf8")));
    expect(starter.steps[0]?.auto).toEqual({ action: "probe_runtime", args: {} });
  });
});

describe("starter install, operated the way INSTALL.md says", () => {
  it("ends READY with the mode, decision maker and agent recorded", async () => {
    const home = await makeTempHome();
    const run = await operate({ home, solutionRef: STARTER_REF, script: STARTER_SCRIPT });
    expect(run.final.status).toBe("complete");
    expect(await loadState(home)).toMatchObject({ mode: "team_host", roles: { decision_maker: "Owner" }, runtime: { profile: "fake-agent", support_level: 2 } });
    const report = runCli(["report"], { home }).stdout;
    expect(report).toContain("✅ READY  (6 of 6 steps done) · fixture-starter@1.0.0");
    expect(report).toContain("🤖 Agent      fake-agent 9.9.9 — level 2 of 3 (MCP not checked yet)");
  });
});
```

Run: `npx vitest run tests/e2e/install-doc.test.ts`
Expected: PASS for the INSTALL.md tests once Steps 1–3 are done; if a file is missing, FAIL with ENOENT. (This task adds documents and fixtures, not engine code, so the failing state is "file not found".)

- [ ] **Step 5: Ship the new files and scan them for industry words**

In `package.json`, change `files` to `["dist", "profiles", "solutions", "INSTALL.md"]`.

In `tests/unit/neutrality.test.ts`, change the `it.each` list to:

```ts
  it.each([...files("src"), ...files("tests/fixtures"), ...files("profiles"), ...files("solutions"), "INSTALL.md"])("%s has no industry vocabulary", (path) => {
```

- [ ] **Step 6: Check the package contents**

Run: `npm run build && npm pack --dry-run 2>&1 | grep -E "profiles/|solutions/|INSTALL.md"`
Expected: lists `INSTALL.md`, `profiles/claude-code.json` and `solutions/starter.json`.

- [ ] **Step 7: Run the whole suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck exits 0; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add INSTALL.md solutions tests/fixtures/solution-starter.json tests/e2e/install-doc.test.ts tests/operator/scripted-operator.ts tests/unit/neutrality.test.ts package.json
git commit -m "feat(install): add INSTALL.md and a starter solution"
```

---

### Task 9: Spec, roadmap, decision record and live test guide

**Files:**
- Modify: `docs/superpowers/specs/2026-10-06-installer-design.md`, `docs/superpowers/plans/README.md`, `DECISIONS.md`
- Create: `docs/testing/2026-10-08-plan-2-live-test.md`

**Interfaces:** documentation only; no code changes.

- [ ] **Step 1: Record D46**

In `DECISIONS.md`, change the status line "Status: Design D1–D45. Implementation plans: `docs/superpowers/plans/` (roadmap + Plan 1)." to "Status: Design D1–D46. Implementation plans: `docs/superpowers/plans/` (roadmap + Plans 1–2)." Then add this row directly after the D45 row:

```markdown
| D46 | **Plan 2 needs no secret; BRAIN moves to Plan 3.** Plan 2 = runtime profiles (JSON data), `installer probe` (C2, C4, C4 schema, C5), `https:` refs with a content-sha `recipe_version`, MODE phase, per-runtime hints, `INSTALL.md`. Plan 3 = secrets page + keychain **and** the BRAIN phase (Skills Wiki key, MCP registration, C6 probe, `skillswiki:` refs, combo check). Connector framework moves to Plan 5. **The engine, not the agent, registers the Skills Wiki MCP**, running the profile's registration command with the key read from the keychain, so the key never enters the agent's context (R4/D8 take precedence over D7). Claude Code headless flags verified live on 2.1.294: `-p --output-format json` (`.result`, `.session_id`, `.is_error`), `--json-schema` (`.structured_output`), `-r <id>`, tools off with `--tools "" --strict-mcp-config`. O6 resolved: `claude mcp add [-s scope] --transport http <name> <url> --header "Authorization: Bearer <key>"`. | 2026-10-08 |
```

- [ ] **Step 2: Update the roadmap**

In `docs/superpowers/plans/README.md`, replace the Plan 2, 3 and 5 rows of the table with:

```markdown
| 2 | **Runtime conformance** | Runtime profiles as JSON, `installer probe` (C2, C4, C4 schema, C5) with a capability map in the state and report, `https:` solution refs with `recipe_version`, MODE phase (mode + decision maker), per-runtime hints on `agent_action`, `INSTALL.md`, starter solution (D46) | 1 | §5, §6.1–6.3, §7 | — | [Planned](2026-10-08-02-runtime-conformance.md) |
| 3 | **Secrets + BRAIN phase** | Local browser page for `secret`/`oauth`, OS keychain storage, Skills Wiki key, engine-run MCP registration (O6 syntax verified), C6 probe, `skillswiki:` refs, combo `human_action` verified via `get_active_combo`, `installer disconnect` for the Skills Wiki key (D46) | 1, 2 | §6.2 BRAIN, §7.3 C6, §8.3, §13, §14.2 | O3 (headless OAuth redirect), O10, O15 | Not started |
| 5 | **Connectors + data layer** | Connector definition loader, pinned + checksummed connector packages, `installer disconnect <connector>`, data contract, phase-3 mapping, `records.*` tools, field tags, spreadsheet connector (Google / Microsoft), default sheet creation, import with change preview, optimistic concurrency | 3, 4 | §8.1–8.2, §9, §14.2 (supply chain) | — | Not started |
```

and replace the paragraph under "## Carried forward from Plan 1" that starts "Plan 2 must cover these" with "Plan 2 covers the items below that concern runtime, refs and views; the BRAIN items move to Plan 3 (D46):".

- [ ] **Step 3: Update the spec**

Make these edits in `docs/superpowers/specs/2026-10-06-installer-design.md`:

1. §6.1 "Solution reference": after "or a plain HTTPS URL to a recipe file." add: "`file:<path>` refs are accepted for local solutions and tests. A `skillswiki:` ref needs the Skills Wiki key before `start`, so `INSTALL.md` runs `installer secret skillswiki` first (Plan 3, D46)."
2. §6.3: replace the JSON example's first line `{` … closing `}` with the wrapped shape `{ "status": "step", "view": { "step": { …the same step fields… }, "status": "pending", "attempts": 0, "resume": "installer resume" } }` and add one sentence: "`view.hints` lists the probed runtime's lines from the step's `hints` (D7)."
3. §6.4: replace the example with one that has `"solution": { "ref", "id", "version", "recipe_version" }`, no top-level `phase`, a blocked step recorded as `{ "status": "blocked", "at": "…", "attempts": 3, "hint": "…", "reason": "check failed 3 times" }`, and optional `mode`, `roles: { "decision_maker" }` and `runtime` (the §7.3 capability map).
4. §6.5: change "(6 of 8 phases done)" to "(6 of 8 steps done)". Replace the line `⚠️ Limited   Agent: Pi 0.73 — Level 3 of 4 (tools via CLI, no MCP)` with two lines: `🤖 Agent      pi 0.73 — level 1 of 3 (no session resume, MCP not checked yet)` (six spaces after "Agent", as `agentLine` renders it) and, for the remaining limit, `⚠️ Limited   External WhatsApp: Meta verification pending (1–3 days)` (move the next line up).
5. §4.2: under `<engine_home>/` add `solution/solution.json   # pinned solution (Plan 1)`, `runtime/probe/            # working folder for headless probe calls`, and `state/install-state.json.bak  # previous state (Plan 1)`; change `profiles/<runtime>.yaml` to `profiles/<runtime>.json` (bundled with the package; Plan 2).
6. §7.2: change the profile example to JSON (copy `profiles/claude-code.json`), note that `--tools ""` replaces `--restricted` as the tools-off flag, and replace `mcp_register_hint` with: "Plan 3 adds `mcp_register.cmd`, an argv template the **engine** runs with the key from the keychain (D46)."
7. §7.3: in the C2 row, replace the method with "The agent runs `installer probe` from its shell and reads the JSON back"; in the C6 row add "(Plan 3)"; change "Output: … written to `instance.yaml`" to "Output: capability map in the install state (`runtime`) and the report; support level = number of C4, C5, C6 that pass (0–3)".

- [ ] **Step 4: Write the live test guide**

Create `docs/testing/2026-10-08-plan-2-live-test.md` with the same structure as `docs/testing/2026-10-07-plan-1-live-test.md` (setup, one section per test with commands, Expected and Record, a results table, diagnostics). Tests:

0. Setup: identical to Plan 1's Test 0 (pack into `~/installer-plan2-test`, install with `--prefix`).
1. `installer probe` on the real Claude Code: `installer probe`. Expected: `"profile":"claude-code"`, `"c4_headless":true`, `"c4_schema":true`, `"c5_resume":true`, `"support_level":2`, `"tier":"compatible"`, `"notes":[]`.
2. Starter install from `file:` with the real agent: `installer --home $T/h1 start --solution file:$REPO/solutions/starter.json`, then the three `submit` commands (`'"yes"'`, `'"no"'`, `'"Owner"'`), then `installer --home $T/h1 report`. Expected: `✅ READY  (6 of 6 steps done) · starter@1.0.0` and `🤖 Agent      claude-code <version> — level 2 of 3 (MCP not checked yet)`; `jq .mode,.roles $T/h1/state/install-state.json` prints `"team_host"` and `{"decision_maker":"Owner"}`.
3. `https:` refs: `installer --home $T/h2 start --solution http://example.com/s.json` (exit 2, `$T/h2` not created) and `installer --home $T/h3 start --solution https://example.com/no-such-file.json` (exit 2, message names the URL and the HTTP status; record the status actually returned, since it depends on that server).
4. No agent found: `installer probe --profile $REPO/tests/fixtures/profiles/missing-agent.json` (a profile whose command does not exist). Expected: `"profile":null`, `"tier":"unknown"`, note `No known agent was found; fallbacks will apply`.
5. Clean up: `rm -rf ~/installer-plan2-test`.

Run every command in the guide against the packed CLI before committing, and write the **actual** output into each Expected line (as Plan 1's guide did). If an output differs from the plan's expectation, stop and report it instead of editing the expectation to match.

- [ ] **Step 5: Commit**

```bash
git add DECISIONS.md docs/superpowers/plans/README.md docs/superpowers/specs/2026-10-06-installer-design.md docs/testing/2026-10-08-plan-2-live-test.md
git commit -m "docs: record D46, update spec and roadmap for Plan 2"
```

---

## Self-Review Record

**Spec coverage (Plan 2 scope):**

| Spec item | Task |
|---|---|
| §5 deployment modes Q1–Q3 → mode, decision maker | 6, 8 |
| §6.1 bootstrap `INSTALL.md`, operator rules 1–5, `https:` refs | 1, 8 |
| §6.3 `agent_action` intent + per-runtime hints (D7) | 7 |
| §6.4 `recipe_version`, `mode` in state | 1, 6 |
| §6.5 runtime limits in the report (R5) | 5 |
| §7.1–7.3 C2, C4, C4 schema, C5 probe, capability map, support level | 2, 3, 4 |
| §7.2 profiles as data | 2 |
| §7.5 tiers (compatible / unknown; certified is granted by Plan 10) | 4 |
| D32 headless calls with tools off | 2, 3 |

Moved to Plan 3 by D46: BRAIN phase, C6 probe, `skillswiki:` refs, MCP registration, combo check. Out of scope: direct-model fallback (Plan 7 runner), conversation replay (Plan 6), `installer tool` (Plan 4), host readiness checks (Plan 9).

**Review Focus coverage:** RF1 → Task 3 (`kills a command that runs past the timeout`, `FAKE_AGENT_DROP=json`) and Task 4 (`records an agent that hangs as timed out`); RF2 → Task 3 (`names a command that is not installed`), Task 4 (`returns an unknown runtime…`), Task 5 (`says fallbacks apply…`); RF3 → Task 1 (`refuses a non-200 answer / a redirect to http / a body over the size cap`, `names the URL when the network fails`, CLI `refuses http://… with exit 2 and creates nothing`); RF4 → Task 6 (`refuses a solution whose derive_mode names…`); RF5 → Task 3 (`passes a prompt with shell syntax through literally`).

**Type consistency:** `StatePatch`, `CapabilityMap`, `RuntimeProfile.dir`, `runAction(home, action, state?)`, `viewOf(step, record, profile?)` and `start(deps, existing, ref, recipeVersion?)` are defined once (Tasks 1–4) and used with the same names in later tasks.
