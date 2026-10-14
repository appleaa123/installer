import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConnector, type ConnectorDef } from "../../src/core/connectors.js";
import { ActionFailure } from "../../src/core/failure.js";
import { clientOwnedTokens, parseSignIn } from "../../src/core/google-auth.js";
import { a1Range, columnLetter, sheetsClient, type SheetsClient } from "../../src/core/sheets.js";
import { SIGNED_IN, startFakeGoogle, type FakeGoogle } from "../helpers/fake-google.js";

let fake: FakeGoogle;
let def: ConnectorDef;
let sheets: SheetsClient;

beforeAll(async () => {
  fake = await startFakeGoogle();
  def = await loadConnector("google-sheets", "1");
  sheets = sheetsClient(def, clientOwnedTokens(def.auth, parseSignIn(SIGNED_IN), fake.env), fake.env);
});

afterAll(() => fake.stop());

const seed = (id: string, tabs: Record<string, string[][]>) => fake.debug(`/debug/sheets/${id}`, { title: id, tabs });
const tabsOf = async (id: string) => ((await fake.debug(`/debug/sheets/${id}`)) as { tabs: Record<string, string[][]> }).tabs;

describe("A1 notation", () => {
  it.each([[1, "A"], [4, "D"], [26, "Z"], [27, "AA"], [702, "ZZ"]])("column %i is %s", (index, letters) => {
    expect(columnLetter(index)).toBe(letters);
  });

  it("quotes a tab name and doubles its quotes; no tab means the first sheet", () => {
    expect(a1Range({ spreadsheet_id: "x", tab: "Team's list" }, "A1:ZZ")).toBe("'Team''s list'!A1:ZZ");
    expect(a1Range({ spreadsheet_id: "x" }, "A1:ZZ")).toBe("A1:ZZ");
  });
});

describe("the Sheets API v4 client (D67)", () => {
  it("reads every row of the first sheet, or of a named tab", async () => {
    await seed("s-read", { First: [["name", "email"], ["Ada", "ada@example.com"]], "Team's list": [["x"]] });
    await expect(sheets.readRows({ spreadsheet_id: "s-read" })).resolves.toEqual([["name", "email"], ["Ada", "ada@example.com"]]);
    await expect(sheets.readRows({ spreadsheet_id: "s-read", tab: "Team's list" })).resolves.toEqual([["x"]]);
  });

  it("reads an empty sheet as no rows", async () => {
    await seed("s-empty", { Sheet1: [] });
    await expect(sheets.readRows({ spreadsheet_id: "s-empty" })).resolves.toEqual([]);
  });

  it("appends a row and rewrites one row in place, as text", async () => {
    await seed("s-write", { Sheet1: [["name", "email"], ["Ada", "ada@example.com"]] });
    await sheets.appendRow({ spreadsheet_id: "s-write" }, ["Grace", "=1+1"]);
    await sheets.writeRow({ spreadsheet_id: "s-write" }, 2, ["Ada L.", "ada@example.com"]);
    expect((await tabsOf("s-write")).Sheet1).toEqual([["name", "email"], ["Ada L.", "ada@example.com"], ["Grace", "=1+1"]]);
  });

  it("appends several rows in one call and rewrites several rows with one batch update", async () => {
    await seed("s-batch", { Sheet1: [["name"], ["a"], ["b"]] });
    await sheets.appendRows({ spreadsheet_id: "s-batch" }, [["c"], ["d"]]);
    await sheets.writeRows({ spreadsheet_id: "s-batch" }, [{ row: 2, cells: ["A"] }, { row: 5, cells: ["D"] }]);
    expect((await tabsOf("s-batch")).Sheet1).toEqual([["name"], ["A"], ["b"], ["c"], ["D"]]);
  });

  it("creates a spreadsheet with one tab and its header row", async () => {
    const created = await sheets.createSpreadsheet("Contacts", "Contacts", ["name", "email", "notes"]);
    expect(created.spreadsheet_id).toMatch(/^sheet-\d+$/);
    expect(created.url).toBe(`https://docs.google.com/spreadsheets/d/${created.spreadsheet_id}/edit`);
    await expect(sheets.readRows({ spreadsheet_id: created.spreadsheet_id, tab: "Contacts" })).resolves.toEqual([["name", "email", "notes"]]);
  });

  it.each([
    ["an unknown spreadsheet", { spreadsheet_id: "missing" }, "Google Sheets has no spreadsheet missing: check the link"],
    ["an unknown tab", { spreadsheet_id: "s-read", tab: "Nope" }, "Google Sheets refused the request: Unable to parse range: 'Nope'!A1:ZZ"],
  ])("turns %s into a fixable failure", async (_name, location, message) => {
    await expect(sheets.readRows(location)).rejects.toThrow(ActionFailure);
    await expect(sheets.readRows(location)).rejects.toThrow(message);
  });

  it("says to sign in again when Google refuses the access token", async () => {
    const stale = sheetsClient(def, { accessToken: async () => "not-issued" }, fake.env);
    await expect(stale.readRows({ spreadsheet_id: "s-read" })).rejects.toThrow("Google Sheets refused the sign-in: run 'taskfollow secret google' to sign in again");
  });

  it("asks to try again later when Google is unavailable", async () => {
    await fake.debug("/debug/fail", { status: 503, times: 1 });
    await expect(sheets.readRows({ spreadsheet_id: "s-read" })).rejects.toThrow("Google Sheets answered HTTP 503; try again in a minute");
    await expect(sheets.readRows({ spreadsheet_id: "s-read" })).resolves.toHaveLength(2);
  });

  it("reports an unreachable server as a fixable failure", async () => {
    const offline = sheetsClient(def, { accessToken: async () => "x" }, { INSTALLER_CONNECTOR_SERVER: "http://127.0.0.1:9", INSTALLER_KEYCHAIN: "file" });
    await expect(offline.readRows({ spreadsheet_id: "s-read" })).rejects.toThrow("Cannot reach Google Sheets");
  });
});
