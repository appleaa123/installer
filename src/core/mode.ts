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
