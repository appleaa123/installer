import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calculate } from "../../src/core/calc.js";
import { startRun, type RunRequest } from "../../src/core/runner.js";
import { loadStep } from "../../src/core/runs.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

const ORDERS = [
  { sku: "TEE-BLK", qty: 3, total: "59.70" },
  { sku: "TEE-BLK", qty: 1, total: "19.90" },
  { sku: "CAP", qty: 2, total: "30.00" },
  { sku: "CAP", qty: null, total: "0.10" },
];

describe("calculations the model never does by itself (D144)", () => {
  it("counts, sums, averages and finds the smallest and largest, with money kept exact", () => {
    expect(calculate(ORDERS, { sum: ["total"] })).toEqual({ count: 4, sum: { total: 109.7 }, avg: { total: 27.425 }, min: { total: 0.1 }, max: { total: 59.7 }, missing: {} });
  });

  it("groups by a field, in order of the key", () => {
    const result = calculate(ORDERS, { group_by: "sku", sum: ["qty", "total"] });
    expect(result.groups).toEqual([
      { key: "CAP", count: 2, sum: { qty: 2, total: 30.1 }, avg: { qty: 2, total: 15.05 }, min: { qty: 2, total: 0.1 }, max: { qty: 2, total: 30 }, missing: { qty: 1 } },
      { key: "TEE-BLK", count: 2, sum: { qty: 4, total: 79.6 }, avg: { qty: 2, total: 39.8 }, min: { qty: 1, total: 19.9 }, max: { qty: 3, total: 59.7 }, missing: {} },
    ]);
  });

  it("compares with an earlier result: the change and the change in percent", () => {
    const now = calculate(ORDERS, { sum: ["total"] });
    expect(calculate(ORDERS, { sum: ["total"], compare: { count: 2, sum: { total: 100 } } }).change).toEqual({ count: 2, sum: { total: 9.7 }, percent: { total: 9.7 } });
    expect(calculate(ORDERS, { sum: ["total"], compare: null }).change).toBeNull();
    expect(now.change).toBeUndefined();
  });

  it("reads a nested field, and refuses text that is not a number, naming the row", () => {
    expect(calculate([{ price: { amount: "2.50" } }, { price: { amount: 1 } }], { sum: ["price.amount"] }).sum).toEqual({ "price.amount": 3.5 });
    expect(() => calculate([{ total: "12" }, { total: "twelve" }], { sum: ["total"] })).toThrow("row 2");
  });

  it("refuses something that is not a list", () => {
    expect(() => calculate({ total: 1 } as unknown, { sum: ["total"] })).toThrow("a list");
  });
});

describe("the calc step and last period's figures in a workflow (D144)", () => {
  beforeEach(async () => vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome()));
  afterEach(() => vi.unstubAllEnvs());
  const OUTPUT = { type: "object", properties: { orders: { type: "array" } }, required: ["orders"] };
  const WEEKLY = {
    workflow: "weekly-sales", version: 1, description: "Weekly sales by product", trigger: { manual: true },
    steps: [
      { id: "orders", task: { prompt: "List this week's orders with sku and total.", may_use: ["mcp__shopify__list_orders"], output: OUTPUT } },
      { id: "totals", calc: { from: "${orders.orders}", group_by: "sku", sum: ["total"], compare: "${previous.totals}" } },
    ],
  };
  const run = (home: string, at: string) =>
    startRun({ home, workflow: parseWorkflow(WEEKLY, "weekly-sales", DEFAULT_TOOLS), key: `weekly-sales:${at}`, trigger: { kind: "manual" }, now: () => at } satisfies RunRequest);

  it("computes the totals, and next week compares with the totals of the run before", async () => {
    const home = await runnerHome();
    vi.stubEnv("FAKE_AGENT_TASK", JSON.stringify({ calls: [], answer: { orders: [{ sku: "CAP", total: "10" }, { sku: "TEE", total: "20" }] } }));
    const first = await run(home, "2026-10-12T09:00:00.000Z");
    expect(await loadStep(home, first, "totals")).toMatchObject({ status: "done", output: { count: 2, sum: { total: 30 }, change: null } });
    vi.stubEnv("FAKE_AGENT_TASK", JSON.stringify({ calls: [], answer: { orders: [{ sku: "CAP", total: "15" }, { sku: "TEE", total: "30" }] } }));
    const second = await run(home, "2026-10-19T09:00:00.000Z");
    expect(await loadStep(home, second, "totals")).toMatchObject({ output: { sum: { total: 45 }, change: { count: 0, sum: { total: 15 }, percent: { total: 50 } } } });
  });

  it("refuses a calc step whose source is not one reference", () => {
    expect(() => parseWorkflow({ ...WEEKLY, steps: [WEEKLY.steps[0], { id: "totals", calc: { from: "orders", sum: ["total"] } }] }, "weekly-sales", DEFAULT_TOOLS)).toThrow("from");
    expect(() => parseWorkflow({ ...WEEKLY, steps: [WEEKLY.steps[0], { id: "totals", calc: { from: "${orders.orders}", sum: [] } }] }, "weekly-sales", DEFAULT_TOOLS)).toThrow("sum");
  });
});
