import { access, mkdir, readFile, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveInHome, runAction, runCheck } from "../../src/core/actions.js";
import { InputError } from "../../src/core/inputs.js";
import { setSecret } from "../../src/core/keychain.js";
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

describe("secret_present", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails with a hint naming the secret command until the key is stored, then passes", async () => {
    const home = await makeTempHome();
    vi.stubEnv("INSTALLER_KEYCHAIN_DIR", await makeTempHome());
    const check = { check: "secret_present", args: { id: "demo" } };
    await expect(runCheck(home, check)).resolves.toEqual({ ok: false, hint: expect.stringContaining("run 'taskpilot secret demo'") });
    await setSecret("demo", "k-1");
    await expect(runCheck(home, check)).resolves.toEqual({ ok: true });
  });

  it("refuses an id that is not a secret id", async () => {
    await expect(runCheck(await makeTempHome(), { check: "secret_present", args: { id: "../x" } })).rejects.toThrow(InputError);
  });
});

describe.skipIf(process.platform === "win32")("symbolic links (D34)", () => {
  it("refuses to write through a linked folder that points outside the home", async () => {
    const home = await makeTempHome();
    const outside = await makeTempHome();
    await symlink(outside, join(home, "config"));
    await expect(runAction(home, { action: "write_file", args: { path: "config/a.txt", content: "x" } })).rejects.toThrow(/symbolic link/);
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("refuses to write to a linked file whose target does not exist yet", async () => {
    const home = await makeTempHome();
    const outside = await makeTempHome();
    await mkdir(join(home, "config"));
    await symlink(join(outside, "target.txt"), join(home, "config", "a.txt"));
    await expect(runAction(home, { action: "write_file", args: { path: "config/a.txt", content: "x" } })).rejects.toThrow(/symbolic link/);
    await expect(access(join(outside, "target.txt"))).rejects.toThrow();
  });

  it("refuses to check a file through a link instead of reporting on the outside file", async () => {
    const home = await makeTempHome();
    const outside = await makeTempHome();
    await symlink(outside, join(home, "config"));
    await expect(runCheck(home, { check: "file_exists", args: { path: "config" } })).rejects.toThrow(/symbolic link/);
  });

  it("still works when the home itself is reached through a link", async () => {
    const real = await makeTempHome();
    const link = join(await makeTempHome(), "home-link");
    await symlink(real, link);
    await runAction(link, { action: "write_file", args: { path: "config/a.txt", content: "x" } });
    await expect(readFile(join(real, "config", "a.txt"), "utf8")).resolves.toBe("x");
  });
});
