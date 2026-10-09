import { readFile } from "node:fs/promises";

/** The installer's own version, from the package.json that ships next to dist/ (src/core → ../../, dist/core → ../../). */
export async function installerVersion(): Promise<string> {
  const json = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
  return typeof json.version === "string" ? json.version : "unknown";
}
