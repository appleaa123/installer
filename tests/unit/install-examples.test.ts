import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { workflowCommand } from "../../src/core/lifecycle.js";
import { writePinnedSolution } from "../../src/core/pin.js";
import { loadWorkflow } from "../../src/core/workflow.js";
import { runnerHome } from "../helpers/runner-home.js";

/** The example workflows INSTALL.md gives the agent (section 9b) must load as they are, once their placeholders are filled. */
async function examples(): Promise<unknown[]> {
  const text = await readFile("INSTALL.md", "utf8");
  const section = text.slice(text.indexOf("## 9b."), text.indexOf("## 10."));
  const blocks = [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => (match[1] ?? "").replace(/^ {5}/gm, ""));
  const filled = (block: string) => block.replaceAll("<store>", "demo").replaceAll("<decision maker's name>", "Owner").replaceAll("<server>", "shopify").replaceAll("<read tool>", "get-product").replaceAll("<update tool>", "update-product");
  return blocks.map((block) => JSON.parse(filled(block)) as unknown);
}

describe("the online-store examples in INSTALL.md (D145)", () => {
  it("has the three examples, and the agent can add each one as written", async () => {
    const found = await examples();
    expect(found).toHaveLength(3);
    const home = await runnerHome();
    await writePinnedSolution(home, await readFile("solutions/starter.json", "utf8"));
    for (const [index, example] of found.entries()) {
      expect(await workflowCommand(home, "add", `example-${index}`, JSON.stringify(example), () => "2026-10-14T12:00:00.000Z")).toMatchObject({ status: "added", mode: "typed" });
    }
    const loaded = await loadWorkflow(home, "example-1", DEFAULT_TOOLS);
    expect(loaded.trigger).toMatchObject({ kind: "cron", tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  });

  it("asks a person before anything reaches a customer, and lets no model do the arithmetic", async () => {
    const [support, sales, product] = (await examples()) as { steps: Record<string, unknown>[] }[];
    expect(support?.steps.at(-1)).toMatchObject({ approve: { tool: "channel.send" } });
    expect(sales?.steps.some((step) => "calc" in step)).toBe(true);
    expect(product?.steps.at(-1)).toMatchObject({ approve: { agent_call: { tool: "mcp__shopify__update-product" } } });
    for (const example of [support, sales, product]) {
      for (const step of example?.steps ?? []) if ("task" in step) expect(step.task).not.toHaveProperty("changes", true);
    }
  });

  it("asks the product draft for the update tool's own arguments, so the approved call can be made as approved (task 28)", async () => {
    const product = ((await examples()) as { steps: { task?: { prompt: string } }[] }[])[2];
    expect(product?.steps[0]?.task?.prompt).toContain("only the arguments that tool takes");
    expect(product?.steps[0]?.task?.prompt).toContain("not the tool name");
  });
});
