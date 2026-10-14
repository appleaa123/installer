import { join, resolve } from "node:path";
import { writeConfig } from "./data-source.js";
import { InputError } from "./inputs.js";
import { PROFILES_DIR, loadProfileById, versionAtLeast, type RuntimeProfile } from "./profile.js";
import type { CapabilityMap } from "./types.js";

/**
 * Local certification (spec §15 as adapted by D48 and D116): no paid CI, so a person certifies a runtime on their
 * own machine with `taskpilot certify --profile <id>`. It runs the offline suite, then the opt-in live checks
 * (tests/live, through their INSTALLER_LIVE gate, as a child process), probes the real agent (C2, C4, C4 schema,
 * C5; C6 is the live suite's rehearsal) and writes a dated record under `<home>/certification/`. The tier follows
 * §7.5: Certified only when everything ran and passed on a bundled profile whose vendor terms were reviewed, from a
 * clean checkout; otherwise Compatible when the agent answers headless calls, else Unknown.
 */
export const CERTIFY_DIR = "certification";
/** Set to `none` by the test suite, so certify never runs the suite inside itself (the real run is a person's task). */
export const SUITES_ENV = "INSTALLER_CERTIFY_SUITES";
/** Tells the live tests which profile to use for their agent checks (judge call, C6 rehearsal). */
export const LIVE_PROFILE_ENV = "INSTALLER_LIVE_PROFILE";
/** The environment names the full live matrix needs; only their presence is checked, never their values. */
export const LIVE_KEYS = [
  "SKILLSWIKI_API_KEY", "SKILLSWIKI_MCP_URL", "SKILLSWIKI_LIVE_RESOURCE", "SKILLSWIKI_LIVE_FILE",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_TEST_SHEET_ID",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_TEST_CHAT_ID",
  "TEST_EMAIL_ADDRESS", "TEST_EMAIL_APP_PASSWORD", "TEST_EMAIL_IMAP_HOST", "TEST_EMAIL_IMAP_PORT", "TEST_EMAIL_IMAP_SECURITY",
  "TEST_EMAIL_SMTP_HOST", "TEST_EMAIL_SMTP_PORT", "TEST_EMAIL_SMTP_SECURITY",
] as const;
/** The real agent's C6 rehearsal in tests/live (it costs tokens, so the person turns it on). */
export const LIVE_AGENT_ENV = "INSTALLER_LIVE_AGENT";

export type Tier = "certified" | "compatible" | "unknown";
type Env = Readonly<Record<string, string | undefined>>;

export interface SuiteResult {
  readonly status: "passed" | "failed" | "not_run";
  readonly files: number;
  readonly tests: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly note?: string;
}

export interface CertifyDeps {
  /** Runs the offline suite (`live: false`) or the live checks for `profile` (`live: true`). */
  readonly runSuite: (live: boolean, profile: string) => Promise<SuiteResult>;
  readonly probe: (profile: RuntimeProfile) => Promise<CapabilityMap>;
  readonly checkout: () => Promise<{ readonly commit: string; readonly dirty: boolean }>;
  readonly version: string;
  readonly env: Env;
  readonly platform: string;
  readonly now: () => string;
}

export interface CertificationRecord {
  readonly format: 1;
  readonly at: string;
  readonly profile: string;
  readonly agent_version: string | null;
  readonly platform: string;
  readonly node: string;
  readonly installer: string;
  readonly commit: string;
  readonly dirty: boolean;
  readonly offline: SuiteResult;
  readonly live: SuiteResult & { readonly missing: readonly string[] };
  readonly probe: CapabilityMap;
  readonly tos_review: RuntimeProfile["tos_review"]["status"];
  readonly tier: Tier;
  /** Why the tier is not Certified; empty when it is. */
  readonly reasons: readonly string[];
}

export const NOT_RUN = (note: string): SuiteResult => ({ status: "not_run", files: 0, tests: 0, passed: 0, failed: 0, skipped: 0, note });

/** The live keys and switches missing from the environment, by name. */
export function missingLiveKeys(env: Env): string[] {
  return [...LIVE_KEYS.filter((name) => (env[name] ?? "") === ""), ...(env[LIVE_AGENT_ENV] === "1" ? [] : [`${LIVE_AGENT_ENV}=1`])];
}

type Parts = Omit<CertificationRecord, "tier" | "reasons">;

/** §7.5 tiers from what ran; every gap that keeps a run from Certified is named. */
export function tierOf(parts: Parts, profile: RuntimeProfile): { readonly tier: Tier; readonly reasons: readonly string[] } {
  const { probe, offline, live } = parts;
  const versionOk = probe.agent_version !== null && versionAtLeast(probe.agent_version, profile.min_version);
  const reviewed = profile.tos_review.status === "ok";
  const reasons = [
    ...(offline.status === "passed" ? [] : [`the offline suite ${offline.status === "failed" ? "failed" : "did not run"}`]),
    ...(live.status === "passed" ? [] : [`the live checks ${live.status === "failed" ? "failed" : "did not run"}`]),
    ...(live.status === "passed" && live.skipped > 0 ? [`the live checks skipped ${live.skipped} test${live.skipped === 1 ? "" : "s"}`] : []),
    ...(live.missing.length === 0 ? [] : [`the live checks lacked ${live.missing.join(", ")}`]),
    ...(probe.c4_headless && probe.c4_schema && probe.c5_resume ? [] : ["the agent did not pass C4, C4 schema and C5"]),
    ...(versionOk ? [] : [`the agent's version is unknown or older than ${profile.min_version}`]),
    ...(reviewed ? [] : [`the vendor's terms are not reviewed (tos_review: ${profile.tos_review.status})`]),
    ...(profile.dir === resolve(PROFILES_DIR) ? [] : ["the profile is not one the installer ships"]),
    ...(parts.dirty ? ["the checkout has changes that are not committed"] : []),
  ];
  if (reasons.length === 0) return { tier: "certified", reasons };
  return { tier: probe.c4_headless && versionOk && reviewed ? "compatible" : "unknown", reasons };
}

/** Runs the matrix for one profile on this machine and writes the dated record (D116). The live checks run only after the offline suite passed. */
export async function certify(home: string, profileId: string | undefined, deps: CertifyDeps): Promise<CertificationRecord & { readonly file: string }> {
  if (!profileId) throw new InputError("certify needs --profile <id>, for example: taskpilot certify --profile claude-code");
  const profile = await loadProfileById(profileId);
  const at = deps.now();
  // The commit is read first: it names what the suites below test.
  const { commit, dirty } = await deps.checkout();
  const offline = await deps.runSuite(false, profile.id);
  const live = offline.status === "passed" ? await deps.runSuite(true, profile.id) : NOT_RUN("the offline suite did not pass");
  const probe = await deps.probe(profile);
  const parts: Parts = {
    format: 1, at, profile: profile.id, agent_version: probe.agent_version, platform: deps.platform, node: process.version, installer: deps.version,
    commit, dirty, offline, live: { ...live, missing: missingLiveKeys(deps.env) }, probe, tos_review: profile.tos_review.status,
  };
  const record: CertificationRecord = { ...parts, ...tierOf(parts, profile) };
  const file = join(CERTIFY_DIR, `${at.replace(/[:.]/g, "-")}-${profile.id}.json`);
  await writeConfig(home, file, record);
  return { ...record, file: join(home, file) };
}
