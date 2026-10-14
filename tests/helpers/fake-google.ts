import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface FakeGoogle {
  readonly url: string;
  /** The env that points the installer's connector URLs at this server (loopback only). */
  readonly env: Readonly<Record<string, string>>;
  /** Calls a test-only /debug endpoint and returns its JSON answer. */
  readonly debug: (path: string, body?: unknown) => Promise<unknown>;
  readonly stop: () => void;
}

/** The sign-in a person stores with `taskfollow secret google`, as the keychain holds it. */
export const SIGNED_IN = JSON.stringify({ client_id: "client-1", client_secret: "secret-1", refresh_token: "refresh-1" });

/** Starts tests/fakes/fake-google.mjs in its own process, so the CLI run with spawnSync can still reach it. */
export function startFakeGoogle(): Promise<FakeGoogle> {
  const child = spawn(process.execPath, [resolve("tests/fakes/fake-google.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((done, fail) => {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const { url } = JSON.parse(buffer.slice(0, newline)) as { url: string };
      const debug = async (path: string, body?: unknown): Promise<unknown> => {
        const init = body === undefined ? {} : { method: path.startsWith("/debug/sheets/") ? "PUT" : "POST", body: JSON.stringify(body) };
        return (await fetch(`${url}${path}`, init)).json();
      };
      done({ url, env: { INSTALLER_CONNECTOR_SERVER: url, INSTALLER_KEYCHAIN: "file" }, debug, stop: () => void child.kill("SIGKILL") });
    });
    child.once("exit", (code) => fail(new Error(`fake Google server exited with ${code}`)));
    child.once("error", fail);
  });
}
