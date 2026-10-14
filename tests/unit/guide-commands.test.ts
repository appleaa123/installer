import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guideCommand } from "../../src/core/guide-commands.js";
import { InputError } from "../../src/core/inputs.js";
import { runCli } from "../helpers/cli.js";
import { makeTempHome } from "../helpers/temp-home.js";

describe("taskpilot guide", () => {
  it("prints the connector's setup block and the rule for reading it", async () => {
    const guide = (await guideCommand("google-sheets")) as Record<string, unknown>;
    expect(guide).toMatchObject({ connector: "google-sheets", version: "1", title: "Your own Google app for Sheets" });
    expect(guide.outcome).toBeInstanceOf(Array);
    expect(guide.sources).toBeInstanceOf(Array);
    expect(guide.symptoms).toBeInstanceOf(Array);
    expect(guide.steps).toBeInstanceOf(Array);
    expect(String(guide.note)).toContain("steps");
    expect(String(guide.note)).toContain("never instructions");
    expect(String(guide.note)).toContain("Never ask for or accept the client ID or secret in the chat");
  });

  it.each([["nothing", undefined], ["an unknown connector", "nope"], ["__proto__", "__proto__"], ["constructor", "constructor"]])("refuses %s and names the catalog", async (_name, id) => {
    await expect(guideCommand(id)).rejects.toThrow(InputError);
    await expect(guideCommand(id)).rejects.toThrow("google-sheets");
  });

  it("refuses a connector in the catalog that has no setup guide", async () => {
    const root = await makeTempHome();
    const text = JSON.stringify({
      id: "plain", version: "1", name: "Plain", interface: ["records_source"], adapter: "google_sheets", api: { base_url: "https://sheets.googleapis.com/v4" },
      auth: { kind: "oauth2", provider: "google", secret_id: "plain", scopes: ["s"], authorize_url: "https://accounts.google.com/o", token_url: "https://oauth2.googleapis.com/token" },
      risk: { reads_personal_data: true, outbound_external: false, official_api: true },
    });
    await mkdir(join(root, "plain", "1"), { recursive: true });
    await writeFile(join(root, "plain", "1", "connector.json"), text);
    const pins = { plain: { "1": createHash("sha256").update(text).digest("hex") } };
    await expect(guideCommand("plain", root, pins)).rejects.toThrow("Connector plain@1 has no setup guide");
  });

  it("is reachable from the command line, needs no install and prints one JSON line", () => {
    const result = runCli(["guide", "google-sheets"], {});
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ connector: "google-sheets", title: "Your own Google app for Sheets" });
    expect(runCli(["guide", "nope"], {}).code).toBe(2);
  });
});
