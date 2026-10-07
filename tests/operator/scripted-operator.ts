import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli, type CliResult } from "../helpers/cli.js";

export interface OperatorScript {
  readonly answers: Readonly<Record<string, unknown>>;
  readonly perform: Readonly<Record<string, (home: string) => Promise<void>>>;
  readonly giveUp?: readonly string[];
}

export interface CrashPlan {
  readonly point: string;
  readonly atCall: number;
}

export interface OperatorRun {
  readonly final: { readonly status: string };
  readonly calls: readonly CliResult[];
  readonly crashed: number;
}

interface StepJson {
  readonly status: string;
  readonly view?: { readonly step: { readonly step_id: string; readonly type: string } };
  readonly next?: StepJson;
}

const MAX_CALLS = 60;

const writeMarker = (path: string) => async (home: string): Promise<void> => {
  await mkdir(join(home, "config"), { recursive: true });
  await writeFile(join(home, path), "ok\n", "utf8");
};

export const FIXTURE_SCRIPT: OperatorScript = {
  answers: { "mode.shared-work": "yes", "mode.report-time": "09:00" },
  perform: { "brain.register": writeMarker("config/agent-marker.txt"), "channels.optional-extra": writeMarker("config/extra-channel.txt") },
};

export const GIVE_UP_SCRIPT: OperatorScript = { ...FIXTURE_SCRIPT, giveUp: ["channels.optional-extra"] };

/** A fake agent: follows the step protocol exactly as INSTALL.md tells a real agent to. */
export async function operate(options: { home: string; solutionRef: string; script: OperatorScript; crash?: CrashPlan }): Promise<OperatorRun> {
  const calls: CliResult[] = [];
  let crashed = 0;
  const call = (args: readonly string[]): CliResult => {
    const env = options.crash && calls.length === options.crash.atCall ? { INSTALLER_CRASH_AT: options.crash.point } : undefined;
    const result = runCli(args, { home: options.home, ...(env ? { env } : {}) });
    calls.push(result);
    return result;
  };
  const recover = (): CliResult => {
    const resumed = call(["resume"]);
    return resumed.code === 2 && resumed.stderr.includes("No install found") ? call(["start", "--solution", options.solutionRef]) : resumed;
  };
  const step = (args: readonly string[]): StepJson => {
    let result = call(args);
    if (result.signal === "SIGKILL") {
      crashed += 1;
      result = recover();
    }
    if (result.code !== 0) throw new Error(`installer ${args.join(" ")} failed: ${result.stderr}`);
    const json = result.json as StepJson;
    return json.next ?? json;
  };

  let current = step(["start", "--solution", options.solutionRef]);
  while (calls.length < MAX_CALLS) {
    if (current.status === "complete" || current.status === "blocked" || !current.view) return { final: current, calls, crashed };
    const { step_id: id, type } = current.view.step;
    if (type === "ask") {
      if (!(id in options.script.answers)) throw new Error(`No scripted answer for ${id}`);
      current = step(["submit", id, "--value", JSON.stringify(options.script.answers[id])]);
    } else if (type === "agent_action" || type === "human_action") {
      const perform = options.script.giveUp?.includes(id) ? undefined : options.script.perform[id];
      if (perform) await perform(options.home);
      current = perform || type === "agent_action" || options.script.giveUp?.includes(id) ? step(["verify", id]) : step(["submit", id, "--done"]);
    } else {
      current = step(["next"]);
    }
  }
  throw new Error(`Operator exceeded ${MAX_CALLS} calls`);
}
