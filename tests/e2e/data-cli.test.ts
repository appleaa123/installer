import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMapping } from "../../src/core/data-source.js";
import { setSecret } from "../../src/core/keychain.js";
import { runCli } from "../helpers/cli.js";
import { SIGNED_IN, startFakeGoogle, type FakeGoogle } from "../helpers/fake-google.js";
import { makeTempHome } from "../helpers/temp-home.js";

const DATA_REF = `file:${resolve("tests/fixtures/solution-data.json")}`;
let fake: FakeGoogle;
let env: Record<string, string>;

beforeAll(async () => {
  fake = await startFakeGoogle();
  env = { ...fake.env, INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
  await setSecret("google", SIGNED_IN, { INSTALLER_KEYCHAIN: "file", ...env });
});

afterAll(() => fake.stop());

async function installed(): Promise<string> {
  const home = await makeTempHome();
  expect(runCli(["start", "--solution", DATA_REF], { home, env }).code).toBe(0);
  return home;
}

describe("taskpilot connect and taskpilot map (D68)", () => {
  it("creates the default sheet, shows its columns and saves the confirmed mapping", async () => {
    const home = await installed();
    const connected = runCli(["connect", "contact", "--sheet", "new"], { home, env });
    expect(connected).toMatchObject({ code: 0, json: { status: "connected", entity: "contact", next: "Run 'taskpilot map contact' to see its columns" } });
    expect(runCli(["map", "contact"], { home, env }).json).toMatchObject({ columns: ["name", "email", "notes", "balance"], sample: [] });
    const mapped = runCli(["map", "contact", "--value", '{"name":"name","email":"email","notes":"notes","balance":"balance"}'], { home, env });
    expect(mapped).toMatchObject({ code: 0, json: { status: "mapped", entity: "contact" } });
  });

  it("refuses to change the mapping of an entity with a financial field from the agent's shell (review finding 2)", async () => {
    const home = await installed();
    runCli(["connect", "contact", "--sheet", "new"], { home, env });
    expect(runCli(["map", "contact", "--value", '{"name":"name","email":"email","notes":"notes","balance":"balance"}'], { home, env }).code).toBe(0);
    const changed = runCli(["map", "contact", "--value", '{"name":"name","email":"email","notes":"balance","balance":"notes"}'], { home, env });
    expect(changed.code).toBe(2);
    expect(changed.json).toMatchObject({ error: expect.stringContaining("in their own terminal") });
    await expect(loadMapping(home, "contact")).resolves.toMatchObject({ columns: { notes: "notes", balance: "balance" } });
  });

  it.each([
    ["connect without an entity", ["connect"], "connect needs the name of an entity of the data contract, for example: taskpilot connect contact"],
    ["connect without --sheet", ["connect", "contact"], "connect needs --sheet <link of the Google Sheet that holds the contact records>, or --sheet new to create one"],
    ["map before connect", ["map", "contact"], "Connect 'contact' first"],
    ["a sheet Google does not have", ["connect", "contact", "--sheet", "nope"], "Google Sheets has no spreadsheet nope: check the link"],
  ])("refuses %s with exit 2 and the fix", async (_name, args, message) => {
    const result = runCli(args, { home: await installed(), env });
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({ error: expect.stringContaining(message), code: 2 });
  });
});
