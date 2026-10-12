import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A judge schema: one label and a confidence. Kept here (tests/helpers), not in tests/fixtures, which the neutrality scan reads. */
export const LABEL_SCHEMA = {
  type: "object",
  properties: { label: { type: "string", enum: ["now", "later"] }, confidence: { type: "number", minimum: 0, maximum: 1 } },
  required: ["label", "confidence"],
  additionalProperties: false,
};

/** Reads the memos, has a judge label each one, then adds one memo with the labels (L0 read, judge, L1 write). */
export const MEMO_DIGEST = {
  workflow: "memo-digest",
  version: 1,
  description: "Labels the memos and notes the labels",
  trigger: { cron: "0 8 * * 1-5", tz: "America/Toronto" },
  steps: [
    { id: "memos", tool: "memo.list" },
    { id: "sort", foreach: "${memos.memos}", judge: { instructions: "Say whether this memo needs action now or later.", input: "${item.text}", schema: LABEL_SCHEMA } },
    { id: "note", when: "len(sort) > 0", tool: "memo.add", args: { text: "Labels: ${sort[*].label}" } },
  ],
};

/** Writes `workflows/<id>/workflow.json` into the home, the way the WORKFLOWS phase will (Plan 8). */
export async function writeWorkflow(home: string, workflow: Readonly<Record<string, unknown>>): Promise<void> {
  const dir = join(home, "workflows", String(workflow.workflow));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "workflow.json"), JSON.stringify(workflow, null, 2), { mode: 0o600 });
}
