import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE_PROFILE_ENV, NOT_RUN, SUITES_ENV, type CertifyDeps, type SuiteResult } from "./certify.js";
import { runProcess } from "./headless.js";
import { InputError } from "./inputs.js";
import { runProbe } from "./probe.js";
import type { RuntimeProfile } from "./profile.js";
import type { CapabilityMap } from "./types.js";

/**
 * What `taskfollow certify` really runs (D116): vitest as a child process with its JSON report, git for the commit,
 * and the probe in a throwaway folder. The test suite replaces all three with fakes and sets
 * INSTALLER_CERTIFY_SUITES=none, so certify never runs the suite inside itself.
 */
export const CHECKOUT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VITEST = join("node_modules", "vitest", "vitest.mjs");
const SUITE_TIMEOUT_MS = 30 * 60_000;
const GIT_TIMEOUT_MS = 10_000;
type Env = Readonly<Record<string, string | undefined>>;
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

/** The published package has neither tests/ nor vitest: certification runs from a source checkout. */
export async function requireCheckout(root: string = CHECKOUT_ROOT): Promise<string> {
  try {
    await access(join(root, "tests", "live"));
    await access(join(root, VITEST));
    return root;
  } catch {
    throw new InputError("taskfollow certify runs from a source checkout of the installer with its development packages (git clone, npm install, npm run build), not from an installed package");
  }
}

/** vitest's JSON report (`--reporter=json`): passed only when vitest says so and nothing failed. */
export function suiteFromReport(report: unknown, code: number | null): SuiteResult {
  if (!isRecord(report) || typeof report.numTotalTests !== "number") return { ...NOT_RUN(`vitest exited with code ${code} and wrote no report`), status: "failed" };
  const count = (key: string): number => (typeof report[key] === "number" ? (report[key] as number) : 0);
  const ok = report.success === true && code === 0 && count("numFailedTests") === 0;
  return {
    status: ok ? "passed" : "failed", files: Array.isArray(report.testResults) ? report.testResults.length : 0, tests: count("numTotalTests"),
    passed: count("numPassedTests"), failed: count("numFailedTests"), skipped: count("numPendingTests") + count("numTodoTests"),
    ...(ok ? {} : { note: `vitest exited with code ${code}; ${count("numFailedTestSuites")} file(s) could not run` }),
  };
}

function runVitest(root: string, env: Env, report: string): Promise<number | null> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(root, VITEST), "run", "--reporter=json", `--outputFile=${report}`], { cwd: root, env, stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), SUITE_TIMEOUT_MS);
    child.on("error", () => undefined);
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code);
    });
  });
}

/** The offline suite, or the live checks (INSTALLER_LIVE=1) for one profile; INSTALLER_LIVE is cleared for the offline run. */
export function vitestSuites(root: string, env: Env): CertifyDeps["runSuite"] {
  return async (live, profile) => {
    if (env[SUITES_ENV] === "none") return NOT_RUN(`${SUITES_ENV}=none`);
    const dir = await mkdtemp(join(tmpdir(), "installer-certify-"));
    try {
      const report = join(dir, "report.json");
      const code = await runVitest(root, { ...env, INSTALLER_LIVE: live ? "1" : "", [LIVE_PROFILE_ENV]: profile }, report);
      const json: unknown = await readFile(report, "utf8").then((text) => JSON.parse(text) as unknown, () => null);
      return suiteFromReport(json, code);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** The checkout's commit, and whether anything differs from it; without git, `unknown` and not clean. */
export async function checkoutState(root: string): Promise<{ readonly commit: string; readonly dirty: boolean }> {
  const head = await runProcess(["git", "rev-parse", "HEAD"], root, GIT_TIMEOUT_MS);
  const status = await runProcess(["git", "status", "--porcelain"], root, GIT_TIMEOUT_MS);
  return { commit: head.error ? "unknown" : head.stdout.trim(), dirty: status.error !== undefined || status.stdout.trim() !== "" };
}

/** The probe on the real agent, in a throwaway folder (like `taskfollow probe`). */
export async function probeAgent(profile: RuntimeProfile): Promise<CapabilityMap> {
  const cwd = await mkdtemp(join(tmpdir(), "installer-certify-probe-"));
  try {
    return await runProbe({ profiles: [profile], cwd });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
