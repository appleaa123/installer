import type { InstallState, Solution, StepDef, StepWhen } from "./types.js";

/**
 * Which steps are in view (D131). A step with a `when` shows only once the question it names was answered that way.
 * This is worked out from the saved answers every time and never saved itself, so the pinned solution text, its
 * hash and every record stay as they were whatever the person chose.
 */
export function whenHolds(when: StepWhen | undefined, state: InstallState): boolean {
  if (!when) return true;
  // 9.12 item 3: any of several answers; a part whose question was never answered counts as false.
  if ("any" in when) return when.any.some((part) => whenHolds(part, state));
  const record = state.steps[when.step];
  if (record?.status !== "done") return false;
  if (when.equals !== undefined) return record.value === when.equals;
  if (when.includes !== undefined) return Array.isArray(record.value) && record.value.includes(when.includes);
  return false;
}

export const stepVisible = (step: StepDef, state: InstallState): boolean => whenHolds(step.when, state);

export const visibleSteps = (solution: Solution, state: InstallState): StepDef[] => solution.steps.filter((step) => stepVisible(step, state));
