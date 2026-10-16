import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkValues, contractTags } from "../../src/core/contract.js";
import { deriveLevel } from "../../src/core/levels.js";
import { parseSolution } from "../../src/core/solution.js";

/** Item 6a (D166, D171): the four back-office shapes, the invoices-due report and the fallback records they write. */
const STARTER = parseSolution(JSON.parse(readFileSync("solutions/starter.json", "utf8")));
const CONTRACT = STARTER.data_contract ?? { entities: {} };

describe("the fallback records (Task 1, D166)", () => {
  it("starter's contract has lead, invoice and action, and contact is unchanged", () => {
    expect(Object.keys(CONTRACT.entities)).toEqual(["contact", "lead", "invoice", "action"]);
    expect(Object.keys(CONTRACT.entities.contact?.fields ?? {})).toEqual(["name", "email", "notes"]);
    expect(CONTRACT.entities.lead?.key).toBe("email");
    expect(CONTRACT.entities.invoice?.fields.file?.type).toBe("file_ref");
  });

  it("invoice.amount is tagged financial, so records.create of an invoice is L3", () => {
    const derived = deriveLevel({ tool: "records.create", level: "L2", categories: [], writes: [{ entity: "invoice", field: "amount" }] }, contractTags(CONTRACT), {});
    expect(derived.level).toBe("L3");
  });

  it("a lead's status outside its options is refused", () => {
    const lead = CONTRACT.entities.lead;
    if (!lead) throw new Error("no lead entity");
    expect(() => checkValues("lead", lead, { status: "maybe" }, "update")).toThrow("must be one of");
    expect(checkValues("lead", lead, { status: "qualified" }, "update")).toEqual({ status: "qualified" });
  });
});
