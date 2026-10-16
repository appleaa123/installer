import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentOf, CHECK_TTL_MS, type CheckContext } from "./check-commands.js";
import { recordResult, saveChallenge, startChallenge } from "./checks.js";
import { loadProfileById } from "./profile.js";
import { skillRoots } from "./skills.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import type { InstallState } from "./types.js";
import { loadWorkflow, requireWorkflowId } from "./workflow.js";

/**
 * T4, skills in chat (spec 5.2, item 7a). A test skill holding a word goes into the agent's own project skills folder,
 * in a randomly named folder, and is removed when the check ends. The word coming back shows the skill's text reached
 * the agent; whether through its skill system or by reading the file, TaskFollow cannot tell, and says so. A chat
 * result never decides a home and never shows as a workflow's skill (Home 1 relies on T7, Home 2 on T8).
 */
type Raw = Record<string, unknown>;
const PHRASES = ["harbor", "lantern", "meadow", "orchard", "pebble", "quarry", "saddle", "thistle"];
const NO_FOLDER = "Not checked: TaskFollow does not know this agent's skills folder in the install folder (or it was started from the home folder), so it does not write a test skill";

export async function startSkillCheck(home: string, state: InstallState | undefined, flags: Raw, context: CheckContext): Promise<Raw> {
  const { agent, version } = agentOf(state, typeof flags.value === "string" ? flags.value : undefined);
  const workflow = typeof flags.workflow === "string" ? (await loadWorkflow(home, requireWorkflowId(flags.workflow), DEFAULT_TOOLS)).id : undefined;
  const profile = state?.runtime?.profile ? await loadProfileById(state.runtime.profile).catch(() => null) : null;
  const project = profile ? skillRoots(profile, state?.work_dir, process.env).project : undefined;
  if (!project) {
    await recordResult(home, { need: "skills", ...(workflow ? { workflow } : {}), result: "not-checked", reason: NO_FOLDER, at: context.now(), agent, agent_version: version, test: "t4" });
    return { need: "skills", result: "not checked", why: NO_FOLDER };
  }
  const { challenge, word } = await startChallenge(home, { needs: ["skills"], test: "t4", ...(workflow ? { workflow } : {}), agent, agentVersion: version, ttlMs: CHECK_TTL_MS, withWord: true }, context.now());
  const name = `taskfollow-check-${randomBytes(4).toString("hex")}`;
  const phrase = `${PHRASES[randomBytes(1)[0]! % PHRASES.length]} ${randomBytes(2).readUInt16BE(0) % 9000 + 1000}`;
  const folder = join(project, name);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "SKILL.md"), ["---", `name: ${name}`, `description: Use when asked for the check word for ${phrase}.`, "---", "", `When asked for the check word for ${phrase}, answer with exactly: ${word ?? ""}`, ""].join("\n"));
  await saveChallenge(home, { ...challenge, details: { ...(challenge.details ?? {}), skill_dir: folder } });
  return { id: challenge.id, test: "t4", instruction: `What is the check word for ${phrase}? Run: taskfollow check answer ${challenge.id} '<the word>'` };
}
