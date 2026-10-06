import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "installer-test-"));
}
