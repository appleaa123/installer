import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { saveChannel } from "../../src/core/channels.js";
import { InputError } from "../../src/core/inputs.js";
import { inviteCommand, membersCommand } from "../../src/core/invite-commands.js";
import { INVITE_TTL_MS, MEMBERS_DIR, joinWithCode, listMembers, memberFor, newJoinCode } from "../../src/core/members.js";
import { makeTempHome } from "../helpers/temp-home.js";

const ROLES = { decision_maker: "Owner" };
const NOW = "2026-10-08T12:00:00.000Z";
const now = () => NOW;
const ADA = { channel: "telegram", address: "1001" };

/** A home with a Telegram channel set up, so invites can say how to join. */
async function home(): Promise<string> {
  const dir = await makeTempHome();
  await saveChannel(dir, { channel: "telegram", bot: { id: 999, username: "desk_test_bot" }, verified_at: NOW });
  return dir;
}

const invite = async (dir: string, name: string) => (await inviteCommand(dir, ROLES, name, true, now)) as { id: number; code: string; role: string; join: string[] };
const events = async (dir: string): Promise<string[]> => (await readFile(join(dir, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);

describe("taskpilot invite (D77)", () => {
  it("makes a one-time code, says how to join, and stores only the code's hash", async () => {
    const dir = await home();
    const result = await invite(dir, "Ada");
    expect(result).toMatchObject({ id: 1, name: "Ada", role: "member", status: "invited", expires_at: "2026-10-11T12:00:00.000Z" });
    expect(result.code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect(result.join).toEqual([`Telegram: open https://t.me/desk_test_bot?start=${result.code.replace("-", "")} and press Start, or send '/join ${result.code}' to @desk_test_bot`]);
    expect(result).not.toHaveProperty("code_hash");
    const stored = await readFile(join(dir, MEMBERS_DIR, "1.json"), "utf8");
    expect(stored).not.toContain(result.code);
    expect(await events(dir)).toEqual(["member.invited"]);
  });

  it("gives the decision maker's role to the MODE phase's decision maker only (any case)", async () => {
    const dir = await home();
    expect((await invite(dir, "owner")).role).toBe("decision_maker");
    expect((await invite(dir, "Ada")).role).toBe("member");
  });

  it("refuses an agent's shell, audits it, and creates nothing", async () => {
    const dir = await home();
    await expect(inviteCommand(dir, ROLES, "Owner", false, now)).rejects.toThrow("run 'taskpilot invite \"Owner\"' there");
    expect(await events(dir)).toEqual(["member.refused"]);
    await expect(readdir(join(dir, MEMBERS_DIR))).rejects.toThrow();
  });

  it("refuses an empty name, and an install with no channel yet", async () => {
    await expect(inviteCommand(await home(), ROLES, "  ", true, now)).rejects.toThrow(InputError);
    await expect(inviteCommand(await makeTempHome(), ROLES, "Ada", true, now)).rejects.toThrow("No channel is set up yet");
  });

  it("never repeats a code", () => {
    const codes = new Set(Array.from({ length: 200 }, () => newJoinCode()));
    expect(codes.size).toBe(200);
  });
});

describe("joining with a code", () => {
  it("binds the sender's channel identity to the member, once", async () => {
    const dir = await home();
    const { code } = await invite(dir, "Ada");
    const result = await joinWithCode(dir, code, ADA, NOW);
    expect(result).toMatchObject({ joined: { id: 1, name: "Ada", status: "joined", identity: ADA, joined_at: NOW } });
    expect(await memberFor(dir, ADA, NOW)).toMatchObject({ id: 1, name: "Ada", role: "member" });
    expect(await joinWithCode(dir, code, { channel: "telegram", address: "1002" }, NOW)).toEqual({ refused: expect.stringContaining("not valid") });
  });

  it("refuses a wrong code, an identity that already joined, and an expired code", async () => {
    const dir = await home();
    const first = await invite(dir, "Ada");
    const second = await invite(dir, "Ada (email)");
    expect(await joinWithCode(dir, "AAAAA-AAAAA", ADA, NOW)).toEqual({ refused: expect.stringContaining("not valid") });
    await joinWithCode(dir, first.code, ADA, NOW);
    expect(await joinWithCode(dir, second.code, ADA, NOW)).toEqual({ refused: "This telegram account has already joined." });
    const later = new Date(Date.parse(NOW) + INVITE_TTL_MS).toISOString();
    expect(await joinWithCode(dir, second.code, { channel: "email", address: "ada@example.com" }, later)).toEqual({ refused: expect.stringContaining("expired") });
    expect((await listMembers(dir, later)).map((member) => member.status)).toEqual(["joined", "expired"]);
    expect(await events(dir)).toEqual(["member.invited", "member.invited", "member.join_refused", "member.joined", "member.join_refused", "member.expired", "member.join_refused"]);
  });

  it("knows no one who has not joined", async () => {
    const dir = await home();
    await invite(dir, "Ada");
    expect(await memberFor(dir, ADA, NOW)).toBeNull();
  });
});

describe("taskpilot members", () => {
  it("lists members without their code hashes, and removes one from a terminal only", async () => {
    const dir = await home();
    const { code } = await invite(dir, "Ada");
    await joinWithCode(dir, code, ADA, NOW);
    expect(await membersCommand(dir, { sub: undefined, id: undefined, interactive: false }, now)).toEqual({ members: [expect.not.objectContaining({ code_hash: expect.anything() })] });
    await expect(membersCommand(dir, { sub: "remove", id: "1", interactive: false }, now)).rejects.toThrow("not by the agent");
    expect(await membersCommand(dir, { sub: "remove", id: "1", interactive: true }, now)).toMatchObject({ id: 1, status: "removed" });
    expect(await memberFor(dir, ADA, NOW)).toBeNull();
    await expect(membersCommand(dir, { sub: "remove", id: "x", interactive: true }, now)).rejects.toThrow("members needs nothing (list) or: remove <id>");
  });
});
