import { revise, type Advanced, type EngineDeps } from "./engine.js";
import { InputError } from "./inputs.js";
import { stepVisible } from "./visibility.js";
import type { InstallState, Solution, StepDef, StepWhen } from "./types.js";

/**
 * Services the person can choose during the install and add later (D134). A service question is an `ask` step whose id
 * starts with `services.` and whose options are service names (plus `none`); other steps depend on it with `when`.
 * `mode.who` and the like are not services and are never offered here.
 */
const isServicePicker = (step: StepDef): boolean =>
  step.type === "ask" && step.step_id.startsWith("services.") && (step.input?.kind === "choice" || step.input?.kind === "multi_choice");

const pickers = (solution: Solution): StepDef[] => solution.steps.filter(isServicePicker);

function included(picker: StepDef, state: InstallState, option: string): boolean {
  const value = state.steps[picker.step_id]?.value;
  return Array.isArray(value) ? value.includes(option) : value === option;
}

/** Options of answered service questions that the person did not choose, in the solution's order. */
export function addableOptions(solution: Solution, state: InstallState): string[] {
  const found: string[] = [];
  for (const picker of pickers(solution)) {
    if (state.steps[picker.step_id]?.status !== "done") continue;
    for (const option of picker.input?.options ?? []) {
      if (option !== "none" && !included(picker, state, option) && !found.includes(option)) found.push(option);
    }
  }
  return found;
}

/** The questions a condition looks at, in any of its forms. */
function conditionSteps(when: StepWhen | undefined): string[] {
  if (!when) return [];
  if ("any" in when) return when.any.flatMap(conditionSteps);
  if ("all" in when) return when.all.flatMap(conditionSteps);
  return [when.step];
}

/**
 * `taskfollow add install` after a consultation (D163): the same home becomes an install, with the consult's results
 * kept. The workflows' skill folders come back with their own rules, and TaskFollow's tools are registered again.
 */
async function continueAfterConsult(deps: EngineDeps, state: InstallState): Promise<Advanced> {
  if (state.steps[PURPOSE]?.value !== "consult") throw new InputError("This setup is not a consultation, so there is nothing to switch: it already sets TaskFollow up to run your work");
  const { readConfig } = await import("./data-source.js");
  const { CONSULT_FILE, restoreAfterConsult } = await import("./consult.js");
  if ((await readConfig(deps.home, CONSULT_FILE)) !== null) {
    await (await import("./actions.js")).runAction(deps.home, { action: "register_tools_mcp" }, state);
    await restoreAfterConsult(deps.home);
  }
  return revise(deps, state, PURPOSE, "install", "agent");
}

const PURPOSE = "mode.purpose";

/** `taskfollow add <service>`: the answer gains the service and its steps come into view. Never guesses a name. */
export async function addService(deps: EngineDeps, state: InstallState, option: string): Promise<Advanced> {
  if (option === "install") return continueAfterConsult(deps, state);
  const all = pickers(deps.solution);
  if (all.length === 0) throw new InputError("This install was made before services could be chosen, so nothing can be added to it this way");
  const hosts = option === "none" ? [] : all.filter((picker) => picker.input?.options?.includes(option));
  const picker = hosts[0];
  if (!picker) {
    const addable = addableOptions(deps.solution, state);
    throw new InputError(`'${option}' is not something this install can add. You can add: ${addable.join(", ") || "nothing more"}`);
  }
  // 9.12 item 3: a question this setup never asks (Telegram for a team, which always has it) cannot be reopened; while
  // the answers that decide whether it is asked are still missing, the install is simply not far enough yet.
  if (!stepVisible(picker, state)) {
    if (conditionSteps(picker.when).some((id) => state.steps[id]?.status !== "done")) throw new InputError(`Finish the install first: the question '${picker.title}' is not answered yet. Answer it, then add ${option}`);
    throw new InputError(`${option} is already part of this setup, or does not apply to it: the question '${picker.title}' is not asked here`);
  }
  if (state.steps[picker.step_id]?.status !== "done") throw new InputError(`Finish the install first: the question '${picker.title}' is not answered yet. Answer it, then add ${option}`);
  if (included(picker, state, option)) throw new InputError(`${option} is already part of this setup`);
  const current = state.steps[picker.step_id]?.value;
  const value = picker.input?.kind === "multi_choice" ? [...(Array.isArray(current) ? current : []), option] : option;
  return revise(deps, state, picker.step_id, value, "agent");
}
