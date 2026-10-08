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
}

export interface Solution {
  readonly id: string;
  readonly version: string;
  readonly steps: readonly StepDef[];
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

export interface InstallState {
  readonly schema: 1;
  readonly solution: { readonly ref: string; readonly id: string; readonly version: string };
  readonly started_at: string;
  readonly steps: Readonly<Record<string, StepRecord>>;
  readonly audit_head?: AuditHead;
}
