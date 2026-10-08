import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONNECTOR_PINS, CONNECTORS_DIR, connectorUrl, loadConnector, oauthConnectorFor } from "../../src/core/connectors.js";
import { ActionFailure } from "../../src/core/failure.js";
import { InputError } from "../../src/core/inputs.js";
import { makeTempHome } from "../helpers/temp-home.js";

const SHIPPED = readFileSync(join(CONNECTORS_DIR, "google-sheets", "1", "connector.json"), "utf8");
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A private connectors folder holding one definition, pinned to its own checksum unless told otherwise. */
async function rootWith(text: string, id = "google-sheets", version = "1"): Promise<string> {
  const root = await makeTempHome();
  await mkdir(join(root, id, version), { recursive: true });
  await writeFile(join(root, id, version, "connector.json"), text);
  return root;
}

const edited = (change: (def: Record<string, unknown>) => Record<string, unknown>): string => JSON.stringify(change(JSON.parse(SHIPPED) as Record<string, unknown>));

describe("the shipped Google Sheets connector (§8.1)", () => {
  it("is pinned to the sha256 of its definition file", () => {
    expect(CONNECTOR_PINS["google-sheets"]?.["1"]).toBe(sha256(SHIPPED));
  });

  it("loads as a records source that asks for the spreadsheets scope only", async () => {
    const def = await loadConnector("google-sheets", "1");
    expect(def).toMatchObject({
      id: "google-sheets", version: "1", interface: ["records_source"], adapter: "google_sheets", sha256: sha256(SHIPPED),
      api: { base_url: "https://sheets.googleapis.com/v4" },
      auth: { kind: "oauth2", provider: "google", secret_id: "google", scopes: ["https://www.googleapis.com/auth/spreadsheets"], token_url: "https://oauth2.googleapis.com/token" },
    });
  });

  it("is the connector that signs in with the 'google' secret", async () => {
    await expect(oauthConnectorFor("google")).resolves.toMatchObject({ id: "google-sheets" });
    await expect(oauthConnectorFor("skillswiki")).resolves.toBeNull();
  });
});

describe("loadConnector refuses what is not pinned (§14.2 supply chain)", () => {
  it("refuses a definition changed after it was pinned, and names both checksums", async () => {
    const root = await rootWith(`${SHIPPED} `);
    await expect(loadConnector("google-sheets", "1", root)).rejects.toThrow(ActionFailure);
    await expect(loadConnector("google-sheets", "1", root)).rejects.toThrow(`google-sheets@1 does not match its pinned checksum (expected sha256:${sha256(SHIPPED)}, found sha256:${sha256(`${SHIPPED} `)}); it was not used`);
  });

  it("refuses a missing package", async () => {
    await expect(loadConnector("google-sheets", "1", await makeTempHome())).rejects.toThrow("The connector package google-sheets@1 is missing from this installation");
  });

  it.each([
    ["an unknown connector", "other", "1", "Connector other@1 is not in this installer's catalog; it has: google-sheets@1"],
    ["an unknown version", "google-sheets", "2", "Connector google-sheets@2 is not in this installer's catalog"],
    ["a path in the id", "../google-sheets", "1", "Connector id '../google-sheets' must be lowercase letters, digits and dashes"],
    ["a path in the version", "google-sheets", "1/../1", "Connector version '1/../1' must be a whole number"],
  ])("refuses %s as a usage error", async (_name, id, version, message) => {
    await expect(loadConnector(id, version)).rejects.toThrow(InputError);
    await expect(loadConnector(id, version)).rejects.toThrow(message);
  });

  it.each([
    ["another id inside", (def: Record<string, unknown>) => ({ ...def, id: "other" }), "declares id 'other'"],
    ["an unknown adapter", (def: Record<string, unknown>) => ({ ...def, adapter: "ftp" }), "adapter must be one of google_sheets"],
    ["no records interface", (def: Record<string, unknown>) => ({ ...def, interface: ["channel"] }), "interface must be [\"records_source\"]"],
    ["an http endpoint", (def: Record<string, unknown>) => ({ ...def, api: { base_url: "http://sheets.example/v4" } }), "api.base_url must be an https URL"],
    ["no scopes", (def: Record<string, unknown>) => ({ ...def, auth: { ...(def.auth as object), scopes: [] } }), "auth.scopes must list at least one scope"],
  ])("refuses a pinned definition with %s", async (_name, change, message) => {
    const text = edited(change);
    const root = await rootWith(text);
    await expect(loadConnector("google-sheets", "1", root, { "google-sheets": { "1": sha256(text) } })).rejects.toThrow(message);
  });
});

describe("connectorUrl", () => {
  it("keeps the definition's URL unless a loopback test server is named", () => {
    expect(connectorUrl("https://sheets.googleapis.com/v4", {})).toBe("https://sheets.googleapis.com/v4");
    expect(connectorUrl("https://sheets.googleapis.com/v4", { INSTALLER_CONNECTOR_SERVER: "http://127.0.0.1:5123" })).toBe("http://127.0.0.1:5123/v4");
    expect(connectorUrl("https://oauth2.googleapis.com/token", { INSTALLER_CONNECTOR_SERVER: "http://127.0.0.1:5123" })).toBe("http://127.0.0.1:5123/token");
  });

  it("refuses a test server that is not on this machine's loopback", () => {
    expect(() => connectorUrl("https://sheets.googleapis.com/v4", { INSTALLER_CONNECTOR_SERVER: "http://example.com" })).toThrow("INSTALLER_CONNECTOR_SERVER must be http://127.0.0.1:<port>");
  });
});
