import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { confinedPath } from "./actions.js";
import { appendAudit } from "./audit.js";
import { sweepChecks } from "./check-fresh.js";
import { summaryCommand } from "./check-summary.js";
import { readConfig, writeConfig } from "./data-source.js";
import { unregisterEverywhere } from "./disconnect.js";
import { TOOLS_MCP_NAME } from "./register.js";
import { REFERENCES_DIR } from "./skills.js";
import { knownValues, scrub } from "./support-bundle.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import type { InstallState } from "./types.js";
import { installTargets, loadWritten, plannedSkillFolder, refreshAgentFile, removeWritten, RULES_FILE, saveWritten, writeWorkflowSkill } from "./workflow-skill.js";
import { loadWorkflow, workflowIds } from "./workflow.js";

/**
 * The consult mode (spec section 9, D163): the interview, the work done once and the checks on a client's own agent,
 * then a report the client keeps and a clean-up that leaves only the results (`state/abilities`) and the interview's
 * workflows in TaskFollow's home. The workflows' own rules are kept there too, so `taskfollow add install` can put the
 * skill folders back unchanged. Nothing of the client's agent settings is touched.
 */
export const CONSULT_FILE = join("state", "consult.json");
const EXPORTS_DIR = "exports";

interface ConsultState {
  readonly rules: Readonly<Record<string, string>>;
  readonly cleaned_at?: string;
  readonly mcp_removed?: boolean;
}

/** The names the person asked the report to leave out (consult.names): each part, and each capitalised word in it. */
export function namesToLeaveOut(state: InstallState | undefined): string[] {
  const value = state?.steps["consult.names"]?.value;
  if (typeof value !== "string") return [];
  const parts = value.split(/[,;\n]|\band\b/).map((part) => part.trim()).filter((part) => part.length >= 2 && part.toLowerCase() !== "none");
  const words = parts.flatMap((part) => part.split(/\s+/)).filter((word) => /^\p{Lu}/u.test(word) && word.length >= 3);
  return [...new Set([...parts, ...words])];
}

/** The client's report: each workflow's page (needs, how we know, the home), scrubbed, under the TaskFollow home's exports. */
export async function consultReport(home: string, state: InstallState | undefined, now: string): Promise<{ readonly file: string }> {
  const ids = await workflowIds(home);
  const context = { interactive: false, now: () => now, launch: async () => ({ pid: 0, opened: false }) };
  const pages: string[] = [];
  for (const id of ids) pages.push(`## ${id}\n\n\`\`\`\n${String((await summaryCommand(home, state, id, {}, context)).text)}\n\`\`\`\n`);
  const known = [...(state ? await knownValues(home, state, now) : []), ...namesToLeaveOut(state)].sort((a, b) => b.length - a.length);
  const body = [
    `# What your assistant can do for you: a consultation (${now.slice(0, 10)})`,
    "",
    "Removed from this report: your name, your business's name, email addresses and long numbers. Read it before forwarding: names of other people in your own words stay.",
    "",
    "Each workflow below lists what it needs, how TaskFollow knows (we saw it, you saw it, or nobody has seen it yet), and where it would run. Every gap says what is missing and your options.",
    "",
    ...(pages.length === 0 ? ["No workflow was chosen in this consultation.", ""] : pages),
    "Next step: to have these run for you, run `taskfollow add install` in this same folder; the results above are kept.",
    "",
  ].join("\n");
  const text = String(scrub(body, known, new Set()));
  const file = await confinedPath(home, join(EXPORTS_DIR, `consult-report-${now.slice(0, 10)}.md`));
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, text, { mode: 0o600 });
  await appendAudit(home, { ts: now, actor: "engine", event: "consult.report", ref: "consult", payload: { workflows: ids.length } });
  return { file };
}

/** The end of a consult: rules kept, skill folders and the CLAUDE.md section removed, test leftovers swept, the tool registration undone. */
export async function consultCleanup(home: string, state: InstallState | undefined, now: string): Promise<{ readonly skill_folders: readonly string[]; readonly agent_file: string; readonly swept: number; readonly mcp_removed: boolean }> {
  const rules: Record<string, string> = {};
  for (const entry of (await loadWritten(home)).skill_folders) {
    try {
      rules[entry.workflow] = await readFile(join(entry.path, REFERENCES_DIR, RULES_FILE), "utf8");
    } catch {
      // A folder already gone keeps no rules.
    }
  }
  const removed = await removeWritten(home);
  const swept = await sweepChecks(home, now, true);
  const unregistered = await unregisterEverywhere(home, state?.runtime?.profile, TOOLS_MCP_NAME);
  const record: ConsultState = { rules, cleaned_at: now, mcp_removed: unregistered.unregistered };
  await writeConfig(home, CONSULT_FILE, record);
  await appendAudit(home, { ts: now, actor: "engine", event: "consult.cleanup", ref: "consult", payload: { skill_folders: removed.skill_folders.length, swept, mcp_removed: unregistered.unregistered } });
  return { skill_folders: removed.skill_folders, agent_file: removed.agent_file, swept, mcp_removed: unregistered.unregistered };
}

const RULES_HEADING = /^# My rules for [^\n]*\n\n/;

/** After a consult, `taskfollow add install`: each workflow's skill folder comes back with its own rules, and the CLAUDE.md section. */
export async function restoreAfterConsult(home: string): Promise<{ readonly skill_folders: readonly string[]; readonly agent_file: string | null }> {
  const saved = ((await readConfig(home, CONSULT_FILE)) as ConsultState | null) ?? { rules: {} };
  const { roots } = await installTargets(home);
  const restored: string[] = [];
  for (const id of await workflowIds(home)) {
    const folder = await plannedSkillFolder(roots, id).catch(() => null);
    if (!folder || !roots.project) continue;
    const workflow = await loadWorkflow(home, id, DEFAULT_TOOLS);
    const rules = saved.rules[id]?.replace(RULES_HEADING, "").trim();
    await writeWorkflowSkill(folder, id, workflow.description, rules);
    const written = await loadWritten(home);
    await saveWritten(home, { ...written, skill_folders: [...written.skill_folders, { workflow: id, path: folder, root: roots.project }] });
    restored.push(folder);
  }
  const agentFile = await refreshAgentFile(home);
  return { skill_folders: restored, agent_file: agentFile };
}
