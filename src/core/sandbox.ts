import { join } from "node:path";
import { appendAudit } from "./audit.js";
import { readConfig, writeConfig } from "./data-source.js";
import { StateCorruptError } from "./state.js";

/**
 * Sandbox mode (spec §15.5, D11, D91). Engine-wide: `config/sandbox.json` says whether the engine is in sandbox;
 * while it is, every outbound message goes to the recording sink (`sandbox/outbox/`) and every workflow run is a
 * sandbox run. Per workflow: `state/workflows/<id>.json` keeps a workflow in sandbox until a person confirmed its
 * dry run (Plan 8's DRY RUN phase). A sandbox run reads for real (L0) but never acts and never asks for an
 * approval: every message and every other action is recorded as it would have happened.
 */
export const SANDBOX_FILE = join("config", "sandbox.json");
export const WORKFLOW_STATE_DIR = join("state", "workflows");
export const SANDBOX_MODE_REASON = "the engine is in sandbox mode, so messages are recorded, not sent (D91)";

export interface SandboxMode {
  readonly on: boolean;
  readonly at: string;
  readonly by: string;
}

export interface WorkflowState {
  readonly workflow: string;
  /** True until a person confirmed a dry run of the workflow's current version. */
  readonly sandbox: boolean;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const stateFile = (id: string): string => join(WORKFLOW_STATE_DIR, `${id}.json`);

export async function loadSandboxMode(home: string): Promise<SandboxMode | null> {
  const raw = await readConfig(home, SANDBOX_FILE);
  if (raw === null) return null;
  if (!isRecord(raw) || typeof raw.on !== "boolean") throw new StateCorruptError(`${SANDBOX_FILE} has an unexpected shape; remove it and run 'installer sandbox on' or 'off' again`);
  return raw as unknown as SandboxMode;
}

/** No file means the engine is not in sandbox (installs before Plan 8 keep their behaviour). */
export const sandboxMode = async (home: string): Promise<boolean> => (await loadSandboxMode(home))?.on === true;

export async function setSandboxMode(home: string, on: boolean, by: string, now: string): Promise<SandboxMode> {
  const mode: SandboxMode = { on, at: now, by };
  await writeConfig(home, SANDBOX_FILE, mode);
  await appendAudit(home, { ts: now, actor: by === "engine" ? "engine" : "human", event: on ? "sandbox.on" : "sandbox.off", ref: SANDBOX_FILE, payload: mode });
  return mode;
}

export async function loadWorkflowState(home: string, id: string): Promise<WorkflowState | null> {
  const raw = await readConfig(home, stateFile(id));
  if (raw === null) return null;
  if (!isRecord(raw) || raw.workflow !== id || typeof raw.sandbox !== "boolean") throw new StateCorruptError(`${stateFile(id)} has an unexpected shape`);
  return raw as unknown as WorkflowState;
}

export const saveWorkflowState = (home: string, state: WorkflowState): Promise<void> => writeConfig(home, stateFile(state.workflow), state);

/** A workflow's runs are sandbox runs while the engine is in sandbox mode or the workflow is not confirmed yet. */
export async function runsInSandbox(home: string, id: string): Promise<boolean> {
  return (await sandboxMode(home)) || (await loadWorkflowState(home, id))?.sandbox === true;
}
