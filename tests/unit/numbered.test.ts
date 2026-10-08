import { mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InputError } from "../../src/core/inputs.js";
import { claimOnce, createRecord, listIds, listRecords, readRecord, removeRecord, replaceRecord } from "../../src/core/numbered.js";
import { StateCorruptError } from "../../src/core/state.js";
import { makeTempHome } from "../helpers/temp-home.js";

interface Note {
  readonly id: number;
  readonly text: string;
}

const DIR = join("state", "notes");
const isNote = (value: unknown): value is Note => typeof value === "object" && value !== null && typeof (value as Note).id === "number" && typeof (value as Note).text === "string";
const note = (text: string) => (id: number): Note => ({ id, text });

describe("numbered records (D57)", () => {
  it("gives ids 1, 2, 3 in a private folder with private files", async () => {
    const home = await makeTempHome();
    const created = [await createRecord(home, DIR, note("a")), await createRecord(home, DIR, note("b")), await createRecord(home, DIR, note("c"))];
    expect(created.map((item) => item.id)).toEqual([1, 2, 3]);
    await expect(listRecords(home, DIR, isNote)).resolves.toEqual([{ id: 1, text: "a" }, { id: 2, text: "b" }, { id: 3, text: "c" }]);
    if (process.platform !== "win32") {
      expect((await stat(join(home, DIR))).mode & 0o777).toBe(0o700);
      expect((await stat(join(home, DIR, "1.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("never gives two records the same id when created at once", async () => {
    const home = await makeTempHome();
    const created = await Promise.all(Array.from({ length: 10 }, (_, n) => createRecord(home, DIR, note(`n${n}`))));
    expect(created.map((item) => item.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect((await listRecords(home, DIR, isNote)).map((item) => item.text).sort()).toEqual(created.map((item) => item.text).sort());
  });

  it("skips an id another process already took, leaving its file alone", async () => {
    const home = await makeTempHome();
    await createRecord(home, DIR, note("first"));
    const original = JSON.stringify({ id: 2, text: "taken" });
    await writeFile(join(home, DIR, "2.json"), original);
    expect((await createRecord(home, DIR, note("third"))).id).toBe(3);
    await expect(readFile(join(home, DIR, "2.json"), "utf8")).resolves.toBe(original);
    expect((await readdir(join(home, DIR))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("reads, replaces and removes one record", async () => {
    const home = await makeTempHome();
    await createRecord(home, DIR, note("a"));
    await replaceRecord(home, DIR, { id: 1, text: "b" });
    await expect(readRecord(home, DIR, 1, isNote)).resolves.toEqual({ id: 1, text: "b" });
    await expect(removeRecord(home, DIR, 1)).resolves.toBe(true);
    await expect(removeRecord(home, DIR, 1)).resolves.toBe(false);
    await expect(readRecord(home, DIR, 1, isNote)).resolves.toBeNull();
    await expect(listIds(home, DIR)).resolves.toEqual([]);
  });

  it("returns nothing for a folder that does not exist yet", async () => {
    await expect(listRecords(await makeTempHome(), DIR, isNote)).resolves.toEqual([]);
  });

  it.each([["not JSON", "{"], ["the wrong shape", '{"id":1}'], ["another id", '{"id":2,"text":"x"}']])("refuses a record file holding %s as damaged state", async (_name, text) => {
    const home = await makeTempHome();
    await mkdir(join(home, DIR), { recursive: true });
    await writeFile(join(home, DIR, "1.json"), text);
    await expect(readRecord(home, DIR, 1, isNote)).rejects.toThrow(StateCorruptError);
    await expect(readFile(join(home, DIR, "1.json"), "utf8")).resolves.toBe(text);
  });

  it("lets exactly one of many concurrent claims win, once", async () => {
    const home = await makeTempHome();
    const results = await Promise.all(Array.from({ length: 8 }, () => claimOnce(home, DIR, 5)));
    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(claimOnce(home, DIR, 5)).resolves.toBe(false);
    await expect(claimOnce(home, DIR, 6)).resolves.toBe(true);
  });

  it.skipIf(process.platform === "win32")("refuses a folder reached through a symbolic link (D34)", async () => {
    const home = await makeTempHome();
    await symlink(await makeTempHome(), join(home, "state"));
    await expect(createRecord(home, DIR, note("a"))).rejects.toThrow(InputError);
  });
});
