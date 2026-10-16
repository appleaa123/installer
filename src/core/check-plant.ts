import { appendAudit } from "./audit.js";
import { loadChannel, openChannel, type OutboundFile } from "./channels.js";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";

/**
 * Planting a test email (spec 5.2 T2 and T8, D160): TaskFollow's own email channel sends it to that channel's own
 * address, nothing else, so the word is on no page. It is a self-addressed test, not a message to a person, so it does
 * not go through `deliver` (D79); it is audited without the word.
 */
export const SUBJECT_PREFIX = "TASKFOLLOW-CHECK";
export const PLANT_BODY = "This is a test email from TaskFollow, sent to your own address to check what your assistant can do. You can delete it.";
export const subjectFor = (id: string, word: string): string => `${SUBJECT_PREFIX} ${id} ${word}`;

export type Plant = (home: string, subject: string, text: string, files?: readonly OutboundFile[]) => Promise<boolean>;

export const plantByChannel: Plant = async (home, subject, text, files) => {
  const config = await loadChannel(home, "email");
  if (!config || config.channel !== "email") return false;
  await (await openChannel(home, "email")).send({ to: config.address, subject, text, ...(files && files.length > 0 ? { attachments: files } : {}) });
  return true;
};

/**
 * Plants through `plant` and audits it (never the word); false when TaskFollow has no way to send it, or sending failed
 * (a missing key, a refused sign-in): then the caller falls back to the person's page (review H4).
 */
export async function plantAndAudit(home: string, plant: Plant, id: string, word: string, test: string, now: string): Promise<boolean> {
  return plantMessage(home, plant, { id, subject: subjectFor(id, word), text: PLANT_BODY, test }, now);
}

/** The same, for a message whose word travels elsewhere (inside an attached file, T2 attachment). */
export async function plantMessage(home: string, plant: Plant, message: { id: string; subject: string; text: string; test: string; files?: readonly OutboundFile[] }, now: string): Promise<boolean> {
  const { id, test } = message;
  let sent: boolean;
  try {
    sent = await plant(home, message.subject, message.text, message.files);
  } catch (error) {
    if (!(error instanceof ActionFailure || error instanceof InputError)) throw error;
    await appendAudit(home, { ts: now, actor: "engine", event: "check.plant_failed", ref: `check:${id}`, payload: { test, why: error.message } });
    return false;
  }
  if (!sent) return false;
  await appendAudit(home, { ts: now, actor: "engine", event: "check.planted", ref: `check:${id}`, payload: { test, to: "the channel's own address" } });
  return true;
}
