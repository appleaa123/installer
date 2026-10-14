import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSecret } from "../../src/core/keychain.js";
import { runCli } from "../helpers/cli.js";
import { startFakeGoogle, type FakeGoogle } from "../helpers/fake-google.js";
import { formHeaders, request, waitForExit } from "../helpers/http.js";
import { makeTempHome } from "../helpers/temp-home.js";

let fake: FakeGoogle;
const pids: number[] = [];

beforeAll(async () => {
  fake = await startFakeGoogle();
});

afterAll(() => {
  fake.stop();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone, which is what the test expects
    }
  }
});

describe("taskpilot secret google (D66)", () => {
  it("opens the sign-in page; the person's client and Google's refresh token end up in the keychain, never on stdout", async () => {
    const dir = await makeTempHome();
    const result = runCli(["secret", "google"], { env: { ...fake.env, INSTALLER_KEYCHAIN_DIR: dir } });
    expect(result.code).toBe(0);
    const { status, url, pid } = result.json as { status: string; url: string; pid: number };
    pids.push(pid);
    expect(status).toBe("waiting");
    expect((await request(url)).text).toContain("Sign in to Google Sheets");
    const consent = await request(url, { method: "POST", headers: formHeaders(new URL(url).origin), body: "client_id=client-1&client_secret=secret-1" });
    const google = new URL(consent.location ?? "");
    const back = await request(`${google.searchParams.get("redirect_uri") ?? ""}?code=code-1&state=${google.searchParams.get("state") ?? ""}`);
    expect(back.text).toContain("Done, you can close this tab.");
    const stored = await getSecret("google", { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: dir });
    expect(JSON.parse(stored ?? "{}")).toEqual({ client_id: "client-1", client_secret: "secret-1", refresh_token: "refresh-1" });
    expect(result.stdout).not.toContain("secret-1");
    await waitForExit(pid);
  });
});
