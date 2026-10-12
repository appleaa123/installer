import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActionFailure } from "../../src/core/failure.js";
import { InputError } from "../../src/core/inputs.js";
import { deleteSecret, getSecret, macAddScript, selectKeychain, setSecret } from "../../src/core/keychain.js";
import { makeTempHome } from "../helpers/temp-home.js";

const fileEnv = async () => ({ INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: join(await makeTempHome(), "keys") });

describe("file keychain backend", () => {
  it("stores, reads back and deletes a value, trimming surrounding whitespace", async () => {
    const env = await fileEnv();
    await setSecret("skillswiki", "  sw_live_abc  ", env);
    await expect(getSecret("skillswiki", env)).resolves.toBe("sw_live_abc");
    await expect(deleteSecret("skillswiki", env)).resolves.toBe(true);
    await expect(getSecret("skillswiki", env)).resolves.toBeNull();
    await expect(deleteSecret("skillswiki", env)).resolves.toBe(false);
  });

  it.skipIf(process.platform === "win32")("keeps the folder and the file private", async () => {
    const env = await fileEnv();
    await setSecret("demo", "k", env);
    expect((await stat(env.INSTALLER_KEYCHAIN_DIR)).mode & 0o777).toBe(0o700);
    expect((await stat(join(env.INSTALLER_KEYCHAIN_DIR, "demo"))).mode & 0o777).toBe(0o600);
    await expect(readdir(env.INSTALLER_KEYCHAIN_DIR)).resolves.toEqual(["demo"]);
  });

  it.each(["Demo", "a/b", "../x", ""])("refuses the secret id %j", async (id) => {
    const env = await fileEnv();
    await expect(getSecret(id, env)).rejects.toThrow(InputError);
  });

  it.each(["", "   ", "two\nlines", "tab\there"])("refuses the value %j", async (value) => {
    const env = await fileEnv();
    await expect(setSecret("demo", value, env)).rejects.toThrow(InputError);
  });
});

describe("backend selection", () => {
  it("needs the folder when the file backend is chosen", () => {
    expect(() => selectKeychain({ INSTALLER_KEYCHAIN: "file" })).toThrow(ActionFailure);
    expect(() => selectKeychain({ INSTALLER_KEYCHAIN: "file" })).toThrow("INSTALLER_KEYCHAIN=file needs INSTALLER_KEYCHAIN_DIR");
  });

  it("refuses an unknown backend name", () => {
    expect(() => selectKeychain({ INSTALLER_KEYCHAIN: "vault" })).toThrow("must be unset or 'file'");
  });

  it.skipIf(process.platform === "win32")("picks the OS keychain when nothing is set", () => {
    expect(selectKeychain({})).toBeDefined();
  });
});

describe("macOS security script", () => {
  it("passes the value on stdin with backslashes and double quotes escaped (fact 1)", () => {
    expect(macAddScript("skillswiki", 'a b"c\\d')).toBe('add-generic-password -U -s installer -a skillswiki -w "a b\\"c\\\\d"\n');
  });
});
