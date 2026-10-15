#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { recordDirectCall } from "./core/watch-record.js";

/**
 * The hook in the person's own Claude Code (D146): `node watch-hook.js <home>`, run after each call the matcher picks.
 * It reads the watched list from the home, records the call, prints nothing and always exits 0.
 */
async function main(): Promise<void> {
  const home = process.argv[2] ?? "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  let services: string[] = [];
  try {
    const config: unknown = JSON.parse(await readFile(join(home, "config", "watch.json"), "utf8"));
    const listed = typeof config === "object" && config !== null ? (config as { services?: unknown }).services : undefined;
    services = Array.isArray(listed) ? listed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return;
  }
  await recordDirectCall(home, Buffer.concat(chunks).toString("utf8"), services, new Date().toISOString());
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
