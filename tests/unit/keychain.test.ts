import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActionFailure } from "../../src/core/failure.js";
import { InputError } from "../../src/core/inputs.js";
import { deleteSecret, encodedCommand, getSecret, macAddScript, selectKeychain, setSecret, winProtectScript, winUnprotectScript } from "../../src/core/keychain.js";
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

describe("Windows keychain backend (D128, Preview)", () => {
  type Call = { argv: readonly string[]; input: string | undefined };
  const fakeRun = (reply: { code: number | null; stdout: string; error?: string }) => {
    const calls: Call[] = [];
    return { calls, run: async (argv: readonly string[], input?: string) => (calls.push({ argv, input }), reply) };
  };
  const winEnv = async () => ({ LOCALAPPDATA: await makeTempHome() });
  const keyFile = (env: { LOCALAPPDATA: string }, id: string) => join(env.LOCALAPPDATA, "taskfollow", "keys", `${id}.dpapi`);

  it("is selected on win32 and stores PowerShell's encrypted answer in a per-user file", async () => {
    const env = await winEnv();
    const { calls, run } = fakeRun({ code: 0, stdout: "01000000d08c9ddf\r\n" });
    await selectKeychain(env, "win32", run).set("demo", "pw");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv.slice(0, 4)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(await readFile(keyFile(env, "demo"), "utf8")).toBe("01000000d08c9ddf");
  });

  it("never puts the secret in the command line; it travels on stdin", async () => {
    const env = await winEnv();
    const { calls, run } = fakeRun({ code: 0, stdout: "abc" });
    await selectKeychain(env, "win32", run).set("demo", "s3cret-value");
    expect(calls[0]?.argv.join(" ")).not.toContain("s3cret-value");
    expect(calls[0]?.input).toBe("s3cret-value");
  });

  it("encodes the script as UTF-16LE base64, the form -EncodedCommand needs", () => {
    const script = winProtectScript();
    expect(Buffer.from(encodedCommand(script), "base64").toString("utf16le")).toBe(script);
    expect(winProtectScript()).toContain("ConvertFrom-SecureString");
    expect(winUnprotectScript()).toContain("ConvertTo-SecureString");
  });

  it("reads null without running PowerShell when there is no file", async () => {
    const { calls, run } = fakeRun({ code: 0, stdout: "x" });
    expect(await selectKeychain(await winEnv(), "win32", run).get("demo")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("decrypts a stored file by piping it to PowerShell on stdin", async () => {
    const env = await winEnv();
    await mkdir(join(env.LOCALAPPDATA, "taskfollow", "keys"), { recursive: true });
    await writeFile(keyFile(env, "demo"), "blob-from-dpapi", "utf8");
    const { calls, run } = fakeRun({ code: 0, stdout: "the-secret" });
    expect(await selectKeychain(env, "win32", run).get("demo")).toBe("the-secret");
    expect(calls[0]?.input).toBe("blob-from-dpapi");
  });

  it("names the item when PowerShell fails, and writes no file", async () => {
    const env = await winEnv();
    const { run } = fakeRun({ code: 1, stdout: "", error: "exit 1" });
    await expect(selectKeychain(env, "win32", run).set("demo", "pw")).rejects.toThrow(ActionFailure);
    await expect(selectKeychain(env, "win32", run).set("demo", "pw")).rejects.toThrow("store 'demo'");
    await expect(readFile(keyFile(env, "demo"), "utf8")).rejects.toThrow();
  });

  it("deletes the file and says whether it existed", async () => {
    const env = await winEnv();
    const { run } = fakeRun({ code: 0, stdout: "abc" });
    const keychain = selectKeychain(env, "win32", run);
    await keychain.set("demo", "pw");
    expect(await keychain.delete("demo")).toBe(true);
    expect(await keychain.delete("demo")).toBe(false);
  });

  it("lets the file backend win on win32 when it is chosen", async () => {
    const env = { ...(await fileEnv()), LOCALAPPDATA: await makeTempHome() };
    const { calls, run } = fakeRun({ code: 0, stdout: "abc" });
    await selectKeychain(env, "win32", run).set("demo", "pw");
    expect(calls).toEqual([]);
  });

  it("still has no backend for a platform it does not know", () => {
    expect(() => selectKeychain({}, "freebsd")).toThrow("No keychain backend for freebsd");
  });
});
