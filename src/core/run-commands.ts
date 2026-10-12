import { randomBytes } from "node:crypto";
import { InputError } from "./inputs.js";
import { startRun } from "./runner.js";
import { loadStep } from "./runs.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { loadWorkflow, requireWorkflowId, workflowIds } from "./workflow.js";

/**
 * `installer run <workflow> [--sandbox]` (spec §6.6): a manual run, now, with a fresh idempotency key (§10.7).
 * `--sandbox` records every outbound message in sandbox/outbox instead of sending it (D90; the full sandbox mode
 * with dry runs is Plan 8).
 */
export async function runCommand(home: string, id: string | undefined, sandbox: boolean, now: () => string): Promise<Record<string, unknown>> {
  if (id === undefined) {
    const ids = await workflowIds(home);
    throw new InputError(`run needs a workflow: ${ids.length > 0 ? ids.join(", ") : "none in this home yet (workflows/<id>/workflow.json)"}`);
  }
  const workflow = await loadWorkflow(home, requireWorkflowId(id), DEFAULT_TOOLS);
  const key = `${workflow.id}:manual:${now()}:${randomBytes(4).toString("hex")}`;
  const record = await startRun({ home, workflow, key, trigger: { kind: "manual" }, now, sandbox });
  const steps = [];
  for (const step of workflow.steps) {
    const log = await loadStep(home, record, step.id);
    steps.push({ step: step.id, status: log?.status ?? "not_run", ...(log?.skipped ? { skipped: true } : {}), ...(log?.error ? { error: log.error } : {}), ...(log?.approval ? { approval: log.approval } : {}) });
  }
  const next = record.status === "waiting" ? { next: `A person decides approval ${record.waiting_on ?? ""} (installer approvals, or a reply code in Telegram); the runner continues the run within a minute after that` } : {};
  return { workflow: record.workflow, run_id: record.run_id, status: record.status, sandbox: record.sandbox, actions: record.actions, needs_human: record.needs_human, ...(record.reason ? { reason: record.reason } : {}), steps, log: `runs/${record.workflow}/${record.run_id}`, ...next };
}
