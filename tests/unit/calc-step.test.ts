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

describe("calc where: only the rows a report is about (D166, D171)", () => {
  beforeEach(async () => vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome()));
  afterEach(() => vi.unstubAllEnvs());
  const INVOICES = [
    { id: "A", status: "to check", amount: "100.00", due: "2026-10-10" },
    { id: "B", status: "approved to pay", amount: "50.50", due: "2026-10-24" },
    { id: "C", status: "paid", amount: "999.00", due: "2026-10-18" },
    { id: "D", status: "to check", amount: "20.00", due: "" },
    { id: "E", status: "to check", amount: "7.00", due: "2026-11-30" },
    { id: "F", status: "approved to pay", amount: "5.00", due: "next week" },
  ];
  const OPEN = ["to check", "approved to pay"];
  const DUE = {
    workflow: "invoices-due", version: 1, description: "Invoices due", trigger: { cron: "0 8 * * 1", tz: "Pacific/Auckland" },
    steps: [
      { id: "open", task: { prompt: "List the invoices.", may_use: ["mcp__sheets__read"], output: { type: "object", properties: { records: { type: "array" } }, required: ["records"] } } },
      { id: "due", calc: { from: "${open.records}", group_by: "currency", sum: ["amount"], where: { status: OPEN, due_within_days: 7 } } },
    ],
  };

  it("calc where keeps any listed status", () => {
    expect(calculate(INVOICES, { sum: ["amount"], where: { fields: { status: OPEN } } })).toMatchObject({ count: 5, sum: { amount: 182.5 } });
  });

  it("calc where counts a row without a date in no_date and leaves it out of count and sum", () => {
    const result = calculate(INVOICES, { sum: ["amount"], where: { fields: { status: OPEN }, due_within_days: 7 }, today: "2026-10-16" });
    expect(result).toMatchObject({ count: 1, sum: { amount: 100 }, no_date: 2 });
  });

  it("calc where due_within_days keeps dates on or before today plus N in the trigger's zone, overdue included", async () => {
    const home = await runnerHome();
    vi.stubEnv("FAKE_AGENT_TASK", JSON.stringify({ calls: [], answer: { records: INVOICES } }));
    // 12:00 UTC on 16 October is already 17 October in Auckland: the 24th is within 7 days there, not in UTC.
    const run = await startRun({ home, workflow: parseWorkflow(DUE, "invoices-due", DEFAULT_TOOLS), key: "invoices-due:1", trigger: { kind: "manual" }, now: () => "2026-10-16T12:00:00.000Z" });
    expect(await loadStep(home, run, "due")).toMatchObject({ status: "done", output: { count: 2, sum: { amount: 150.5 }, no_date: 2, today: "2026-10-17" } });
  });

  it("calc where matches a status whatever its case and spaces (review of PR #61)", () => {
    const typed = [{ id: "X", status: " To Check ", amount: "1.00" }, { id: "Y", status: "PAID", amount: "2.00" }];
    expect(calculate(typed, { sum: ["amount"], where: { fields: { status: ["to check"] } } }).rows).toEqual([typed[0]]);
    expect(calculate(typed, { sum: ["amount"], where: { fields: { status: [" Paid"] } } }).rows).toEqual([typed[1]]);
  });

  it("calc where gives the kept rows, so a report can list exactly those (review of PR #61)", () => {
    const result = calculate(INVOICES, { sum: ["amount"], where: { fields: { status: OPEN }, due_within_days: 7 }, today: "2026-10-16" });
    expect(result.rows?.map((row) => (row as { id: string }).id)).toEqual(["A"]);
    expect(calculate(INVOICES, { sum: ["amount"], where: { fields: { status: ["paid"] } } }).rows).toEqual([INVOICES[2]]);
  });

  it("calc where refuses an unknown key at load", () => {
    const withWhere = (where: unknown) => ({ ...DUE, steps: [DUE.steps[0], { id: "due", calc: { from: "${open.records}", sum: ["amount"], where } }] });
    expect(() => parseWorkflow(withWhere({ status: "to check" }), "invoices-due", DEFAULT_TOOLS)).toThrow("where");
    expect(() => parseWorkflow(withWhere({ due_within_days: "7" }), "invoices-due", DEFAULT_TOOLS)).toThrow("due_within_days");
    expect(() => parseWorkflow(withWhere({ "bad key!": ["x"] }), "invoices-due", DEFAULT_TOOLS)).toThrow("where");
    expect(() => parseWorkflow(withWhere([]), "invoices-due", DEFAULT_TOOLS)).toThrow("where");
  });

  it("due_within_days is refused at load for a workflow whose trigger is not cron", () => {
    expect(() => parseWorkflow({ ...DUE, trigger: { manual: true } }, "invoices-due", DEFAULT_TOOLS)).toThrow("due_within_days");
    expect(parseWorkflow({ ...DUE, trigger: { manual: true }, steps: [DUE.steps[0], { id: "due", calc: { from: "${open.records}", sum: ["amount"], where: { status: OPEN } } }] }, "invoices-due", DEFAULT_TOOLS).steps).toHaveLength(2);
  });

  it("calc without where is unchanged", () => {
    expect(calculate(INVOICES, { sum: ["amount"] })).not.toHaveProperty("no_date");
    expect(calculate(INVOICES, { sum: ["amount"] }).count).toBe(6);
  });
});
