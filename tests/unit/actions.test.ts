import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInHome, runAction, runCheck } from "../../src/core/actions.js";
import { InputError } from "../../src/core/inputs.js";
import { makeTempHome } from "../helpers/temp-home.js";

describe("resolveInHome (D34 confinement)", () => {
  it.each(["../escape.txt", "/etc/hosts", "config/../../escape.txt", ".."])("rejects %s", async (path) => {
    const home = await makeTempHome();
    expect(() => resolveInHome(home, path)).toThrow(InputError);
  });

  it("accepts paths inside the home", async () => {
    const home = await makeTempHome();
    expect(resolveInHome(home, "config/a.txt")).toBe(join(home, "config", "a.txt"));
  });
});

describe("runAction", () => {
  it("write_file is idempotent", async () => {
    const home = await makeTempHome();
    const action = { action: "write_file", args: { path: "config/a.txt", content: "x\n" } };
    await runAction(home, action);
    await runAction(home, action);
    await expect(readFile(join(home, "config", "a.txt"), "utf8")).resolves.toBe("x\n");
  });

  it("refuses to write outside the home", async () => {
    const home = await makeTempHome();
    await expect(runAction(home, { action: "write_file", args: { path: "../x.txt", content: "" } })).rejects.toThrow(InputError);
  });

  it("rejects a content argument that is not a string", async () => {
    const home = await makeTempHome();
    await expect(runAction(home, { action: "write_file", args: { path: "config/a.txt", content: 42 } })).rejects.toThrow("Argument 'content' must be a string");
  });

  it("writes an empty file when content is missing", async () => {
    const home = await makeTempHome();
    await runAction(home, { action: "write_file", args: { path: "config/a.txt" } });
    await expect(readFile(join(home, "config", "a.txt"), "utf8")).resolves.toBe("");
  });

  it("rejects unknown actions", async () => {
    const home = await makeTempHome();
    await expect(runAction(home, { action: "format_disk" })).rejects.toThrow(InputError);
  });

  it("rejects prototype member lookups like constructor", async () => {
    const home = await makeTempHome();
    await expect(runAction(home, { action: "constructor" })).rejects.toThrow(InputError);
  });

  it("rejects prototype member lookups like toString", async () => {
    const home = await makeTempHome();
    await expect(runAction(home, { action: "toString" })).rejects.toThrow(InputError);
  });
});

describe("runCheck", () => {
  it("file_exists passes and fails with the declared hint", async () => {
    const home = await makeTempHome();
    const check = { check: "file_exists", args: { path: "config/a.txt", hint: "a.txt missing" } };
    await expect(runCheck(home, check)).resolves.toEqual({ ok: false, hint: "a.txt missing" });
    await runAction(home, { action: "write_file", args: { path: "config/a.txt", content: "" } });
    await expect(runCheck(home, check)).resolves.toEqual({ ok: true });
  });

  it("rejects prototype member lookups like constructor", async () => {
    const home = await makeTempHome();
    await expect(runCheck(home, { check: "constructor" })).rejects.toThrow(InputError);
  });

  it("rejects prototype member lookups like toString", async () => {
    const home = await makeTempHome();
    await expect(runCheck(home, { check: "toString" })).rejects.toThrow(InputError);
  });
});
