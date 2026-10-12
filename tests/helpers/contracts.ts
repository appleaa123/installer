import { expect, it } from "vitest";
import type { ChannelConnector } from "../../src/core/channels.js";
import type { SheetLocation, SheetsClient } from "../../src/core/sheets.js";

/**
 * Connector contract checks (spec §15.3, D118): one list of checks per connector kind, run against the fakes in the
 * offline suite and against the real service in the opt-in live tests, under those tests' own gates and keys. A
 * fake that passes and a real service that passes behave the same where the engine depends on it.
 */
export interface SheetsTarget {
  readonly client: SheetsClient;
  /** An empty tab of its own: the checks write there in order. */
  readonly location: SheetLocation;
}

/** Rows as the contract compares them: a service may leave out a row's trailing empty cells (Google does). */
const trimmed = (rows: readonly (readonly string[])[]): string[][] => rows.map((row) => {
  const cells = [...row];
  while (cells.at(-1) === "") cells.pop();
  return cells;
});

/** Registers the Sheets adapter's contract; `target` is read when the checks run (after the caller's beforeAll). */
export function sheetsContract(target: () => SheetsTarget): void {
  it("contract: reads an empty tab as no rows", async () => {
    const { client, location } = target();
    await expect(client.readRows(location)).resolves.toEqual([]);
  });

  it("contract: writes a header, appends rows and reads them back as text, a formula kept as typed", async () => {
    const { client, location } = target();
    await client.writeRow(location, 1, ["name", "email", "notes"]);
    await client.appendRow(location, ["Ada", "ada@example.com", "=1+1"]);
    await expect(client.readRows(location)).resolves.toEqual([["name", "email", "notes"], ["Ada", "ada@example.com", "=1+1"]]);
  });

  it("contract: appends several rows in one call and rewrites several rows in one batch", async () => {
    const { client, location } = target();
    await client.appendRows(location, [["Grace", "grace@example.com", ""], ["Alan", "alan@example.com", "x"]]);
    await client.writeRows(location, [{ row: 2, cells: ["Ada L.", "ada@example.com", "met in May"] }, { row: 4, cells: ["Alan T.", "alan@example.com", ""] }]);
    expect(trimmed(await client.readRows(location))).toEqual([
      ["name", "email", "notes"], ["Ada L.", "ada@example.com", "met in May"], ["Grace", "grace@example.com"], ["Alan T.", "alan@example.com"],
    ]);
  });

  it("contract: rewrites one row in place and leaves the others", async () => {
    const { client, location } = target();
    await client.writeRow(location, 3, ["Grace H.", "grace@example.com", "called"]);
    const rows = trimmed(await client.readRows(location));
    expect(rows[1]).toEqual(["Ada L.", "ada@example.com", "met in May"]);
    expect(rows[2]).toEqual(["Grace H.", "grace@example.com", "called"]);
  });
}

export interface ChannelTarget {
  readonly channel: ChannelConnector;
  /** Where the send check writes to: the tester's own chat or mailbox. */
  readonly to: string;
  /** What reached `to`, as text (a fake can tell; a real service cannot, so the check then only sends). */
  readonly delivered?: () => Promise<readonly string[]>;
  /** Makes someone write to the channel (a fake only). */
  readonly inject?: (text: string) => Promise<void>;
}

/** Registers a channel adapter's contract; `receive: false` leaves out the reads (live Telegram: a read would take a running gateway's updates). */
export function channelContract(target: () => ChannelTarget, options: { readonly receive: boolean }): void {
  const signal = (): AbortSignal => new AbortController().signal;

  it("contract: sends a text message to the address", async () => {
    const { channel, to, delivered } = target();
    const text = `installer contract check ${new Date().toISOString()}. You can delete it.`;
    await expect(channel.send({ to, text })).resolves.toBeUndefined();
    if (delivered) expect((await delivered()).some((body) => body.includes(text))).toBe(true);
  });

  if (options.receive) it("contract: reads messages as the gateway needs them: the channel, a sender, a message id and text", async () => {
    const { channel, inject } = target();
    const start = await channel.receive(null, 0, signal());
    if (inject) await inject("contract hello");
    const read = await channel.receive(start.cursor, 0, signal());
    for (const message of read.messages) {
      expect(message).toMatchObject({ channel: channel.id, from: expect.stringMatching(/\S/), message_id: expect.stringMatching(/\S/), text: expect.any(String) });
    }
    if (inject) expect(read.messages.map((message) => message.text)).toContain("contract hello");
  });

  if (options.receive) it("contract: never returns a message twice when read again from the cursor it gave", async () => {
    const { channel, inject } = target();
    const start = await channel.receive(null, 0, signal());
    if (inject) await inject("contract again");
    const first = await channel.receive(start.cursor, 0, signal());
    const second = await channel.receive(first.cursor, 0, signal());
    if (inject) expect(first.messages.map((message) => message.text)).toEqual(["contract again"]);
    const seen = new Set(first.messages.map((message) => message.message_id));
    expect(second.messages.filter((message) => seen.has(message.message_id))).toEqual([]);
  });
}
