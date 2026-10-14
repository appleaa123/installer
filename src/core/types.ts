import type { ChannelPolicy } from "./channel-policy.js";
import type { DataContract } from "./contract.js";

export const PHASES = [
  "PREFLIGHT",
  "MODE",
  "BRAIN",
  "DATA",
  "CHANNELS",
  "WORKFLOWS",
  "DRY_RUN",
  "ACTIVATE",
  "REPORT",
] as const;
export type Phase = (typeof PHASES)[number];

export const STEP_TYPES = ["ask", "human_action", "agent_action", "auto", "verify"] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const INPUT_KINDS = [
  "text",
  "choice",
  "multi_choice",
  "confirm",
  "number",
  "time",
  "cron",
  "secret",
  "oauth",
  "file",
] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

export interface StepInput {
  readonly kind: InputKind;
  readonly options?: readonly string[];
  readonly provider?: string;
}

export interface Action {
  readonly action: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

export interface Check {
  readonly check: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

export interface StepDef {
  readonly step_id: string;
  readonly phase: Phase;
  readonly type: StepType;
  readonly title: string;
  readonly why: string;
  readonly instructions?: readonly string[];
  readonly input?: StepInput;
  readonly blocking: boolean;
  readonly est_minutes?: number;
  readonly intent?: string;
  readonly auto?: Action;
  readonly verify?: Check;
  readonly hints?: Readonly<Record<string, readonly string[]>>;
  /** The id of a pinned connector whose `taskpilot guide` the agent follows for this step (live setup guides). */
  readonly guide?: string;
}

export interface Solution {
  readonly id: string;
  readonly version: string;
  readonly steps: readonly StepDef[];
  /** What records the recipe works with (spec §9.2); a solution without one has no data layer. */
  readonly data_contract?: DataContract;
  /** Outbound rules for external contacts (spec §12.5, D80); none declared means DEFAULT_POLICY. */
  readonly channel_policy?: ChannelPolicy;
  /** Workflows the recipe suggests for the WORKFLOWS phase (§6.2); each is checked when it is added (D98). */
  readonly workflows?: readonly Readonly<Record<string, unknown>>[];
}

export const STEP_STATUSES = ["pending", "done", "blocked", "skipped", "failed"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export interface StepRecord {
  readonly status: StepStatus;
  readonly at: string;
  readonly by?: "human" | "agent" | "engine";
  readonly value?: unknown;
  readonly attempts?: number;
  readonly hint?: string;
  readonly reason?: string;
}

export interface AuditHead {
  readonly seq: number;
  readonly hash: string;
}

export const MODES = ["personal", "team_host", "hybrid"] as const;
export type Mode = (typeof MODES)[number];

export interface Roles {
  readonly decision_maker: string;
}

/** Result of `taskpilot probe` (spec §7.3); C6 is filled in by the BRAIN phase's probe_mcp step (D54). */
export interface CapabilityMap {
  readonly profile: string | null;
  readonly agent_version: string | null;
  readonly c2_shell: boolean;
  readonly c4_headless: boolean;
  readonly c4_schema: boolean;
  readonly c5_resume: boolean;
  readonly c6_mcp: boolean | "not_probed";
  readonly support_level: number;
  readonly tier: "compatible" | "unknown";
  readonly notes: readonly string[];
}

export interface InstallState {
  readonly schema: 1;
  readonly solution: { readonly ref: string; readonly id: string; readonly version: string; readonly recipe_version?: string };
  readonly started_at: string;
  readonly steps: Readonly<Record<string, StepRecord>>;
  readonly audit_head?: AuditHead;
  readonly mode?: Mode;
  readonly roles?: Roles;
  readonly runtime?: CapabilityMap;
  /** The per-client Skills Wiki MCP URL from `start --url`; not a secret, the key lives in the keychain (D51). */
  readonly skillswiki?: { readonly url: string };
  /** Where the agent ran `taskpilot start`: the folder its MCP trust applies to (D54). */
  readonly work_dir?: string;
}

/** What an auto action may change in the install state, merged in the same save as its step record. */
export type StatePatch = Partial<Pick<InstallState, "mode" | "roles" | "runtime">>;
